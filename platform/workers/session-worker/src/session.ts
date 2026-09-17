/**
 * Session implementation — calls real pi SDK (createAgentSession).
 *
 * Master provides RuntimeConfig; we:
 * 1. Call createAgentSession with cwd / agentDir / model / etc.
 * 2. Maintain a running MessageDeltaDTO per message id (accumulating content/thinking)
 * 3. Forward each pi SDK event as a WorkerEvent with simplified DTO data
 * 4. Expose prompt / abort / setModel / setThinkingLevel / setTools
 *
 * Note: createAgentSession accepts an optional `model` (Model<Api>). We resolve
 * the agent's configured model from ModelRegistry and pass it so pi SDK uses it
 * instead of falling back to settings.json defaultModel.
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  formatSkillsForPrompt,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type Skill,
} from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-ai';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  MessageDeltaDTO,
  MessageRole,
  RuntimeConfig,
  ToolCallDTO,
  AgentConfig,
} from '@pi-agent-platform/shared-types';
import { createExtensionsFilter, createSkillsFilter, createPromptsFilter, extractExtensionName } from './resource-filters.js';
import type { WorkerEvent, WorkerEventKind } from '@pi-agent-platform/ipc-protocol';
import { createDefaultTools, type CallMasterFn } from './tools.js';

export type EventEmitter = (event: Omit<WorkerEvent, 'kind'>) => void;

export interface SessionHandle {
  id: string;
  piSessionPath: string;
  /** Actual model the worker will use (resolved from agent config / pi settings). */
  model: { provider: string; modelId: string } | null;
  /** Active thinking level (from pi SDK AgentSession.thinkingLevel). */
  thinkingLevel: ThinkingLevel | null;
}

function defaultAgentDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.env.HOMEPATH ?? '.';
  const sep = home.includes('\\') ? '\\' : '/';
  return `${home}${sep}.pi${sep}agent`;
}

/**
 * Resolve the model the worker will ACTUALLY use for a new session.
 *
 * The worker calls createAgentSession WITHOUT a `model`, so pi SDK picks its own
 * default — which is `settings.json` `defaultModel` / `defaultProvider`. That is
 * the model that really serves requests, so it must be reported back to master
 * (session row / UI).
 *
 * Priority:
 *   1. agent config `model` if it resolves to a registered model
 *   2. pi settings.json `defaultModel` (fallback when agent config not set or unregistered)
 *   3. first available model from the ModelRegistry
 */
export function resolveActualModel(
  runtime: ModelRuntime,
  agentModel: string | undefined,
): { provider: string; modelId: string } | null {
  try {
    const registry = new ModelRegistry(runtime);
    const all = registry.getAvailable();
    if (all.length === 0) return null;

    const find = (str: string) => {
      const slashIdx = str.indexOf('/');
      if (slashIdx > 0) {
        const m = registry.find(str.slice(0, slashIdx), str.slice(slashIdx + 1));
        return m ? { provider: m.provider, modelId: m.id } : undefined;
      }
      const m = all.find((x) => x.id === str);
      return m ? { provider: m.provider, modelId: m.id } : undefined;
    };

    // 1) agent config (what the user configured for this agent)
    if (agentModel) {
      const hit = find(agentModel);
      if (hit) return hit;
    }

    // 2) pi settings.json default (fallback when agent config not set or model not registered)
    //    NOTE: must use top-level imports (readFileSync/join) — this module is ESM,
    //    `require` throws ReferenceError which silently falls through to agent config.
    try {
      const settingsPath = join(defaultAgentDir(), 'settings.json');
      if (existsSync(settingsPath)) {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const defaultModel = settings.defaultModel;
        if (defaultModel) {
          const hit = find(defaultModel);
          if (hit) return hit;
        }
      }
    } catch { /* ignore */ }

    // 3) first available
    const fallback = all[0];
    return fallback ? { provider: fallback.provider, modelId: fallback.id } : null;
  } catch (e) {
    console.warn('[worker] resolveActualModel failed:', e);
    return null;
  }
}

/** Map a pi SDK AgentSessionEvent type to our WorkerEventKind. */
function mapEventType(eventType: string | undefined): WorkerEventKind | null {
  switch (eventType) {
    case 'message_update':
    case 'message':
    case 'message_start':
      return 'message_update';
    case 'message_end':
      return 'message_end';
    case 'tool_execution_start':
      return 'tool_call';
    case 'tool_execution_end':
      return 'tool_result';
    case 'agent_end':
      return 'agent_end';
    case 'queue_update':
      return 'queue_update';
    case 'error':
      return 'error';
    default:
      return null; // skip (agent_start, turn_start, turn_end)
  }
}

/** Read role from a pi SDK message block. */
function roleOf(role: unknown): MessageRole {
  if (role === 'user' || role === 'assistant' || role === 'toolResult') return role;
  // toolResult messages in pi SDK have role='toolResult'
  if (role === 'toolResult') return 'toolResult';
  return 'assistant';
}

/**
 * Extract flattened TEXT from a pi SDK content block array — text blocks only.
 * Skips `thinking` blocks (use `extractThinking` for those) so callers can
 * separately route content vs thinking without double-emitting the thinking
 * text in the body.
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => {
      const block = b as { type: string; text?: unknown };
      return typeof block.text === 'string' ? block.text : '';
    })
    .filter((s) => s.length > 0)
    .join('')
}

/** Extract THINKING text from a pi SDK content block array — thinking blocks only. */
function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'thinking')
    .map((b) => {
      const block = b as { type: string; thinking?: unknown };
      return typeof block.thinking === 'string' ? block.thinking : '';
    })
    .filter((s) => s.length > 0)
    .join('')
}

/** Extract tool-call blocks from a pi SDK content array. */
function extractToolCalls(content: unknown): ToolCallDTO[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const calls: ToolCallDTO[] = [];
  for (const b of content) {
    if (b && typeof b === 'object' && 'type' in b && (b as { type: string }).type === 'toolCall') {
      const t = b as {
        id?: string;
        name?: string;
        arguments?: unknown;
      };
      if (t.id && t.name) {
        calls.push({
          id: t.id,
          name: t.name,
          args: (t.arguments as Record<string, unknown> | undefined) ?? {},
        });
      }
    }
  }
  return calls.length > 0 ? calls : undefined;
}

/**
 * State to track running message deltas — content/thinking accumulates per message id.
 */
class DeltaAccumulator {
  private deltas = new Map<string, MessageDeltaDTO>();

  get(messageId: string): MessageDeltaDTO | undefined {
    return this.deltas.get(messageId);
  }

  upsert(messageId: string, patch: Partial<MessageDeltaDTO>): MessageDeltaDTO {
    const prev = this.deltas.get(messageId) ?? { messageId, role: 'assistant' };
    const next: MessageDeltaDTO = { ...prev, ...patch, messageId };
    this.deltas.set(messageId, next);
    return next;
  }

  finish(messageId: string): MessageDeltaDTO | undefined {
    const cur = this.deltas.get(messageId);
    if (cur) this.deltas.delete(messageId);
    return cur;
  }
}

/**
 * Convert a pi SDK event into a simplified delta DTO.
 * `stableMessageId` is the worker-assigned id kept across start/update/end for one message.
 * Returns null if the event carries no useful payload.
 */
function toDelta(event: Record<string, unknown>, stableMessageId: string | null): { kind: WorkerEventKind; delta: MessageDeltaDTO } | null {
  const type = event.type as string | undefined;
  if (!type) return null;

  // Helper: build delta from a pi SDK message block.
  // Stable id is taken from `stableMessageId` (worker-assigned on message_start).
  const fromMessage = (msg: Record<string, unknown>): MessageDeltaDTO => {
    const role = roleOf(msg.role);
    const content = extractText(msg.content);          // text blocks only
    const thinking = extractThinking(msg.content);    // thinking blocks only
    const toolCalls = role === 'assistant' ? extractToolCalls(msg.content) : undefined;
    return {
      messageId: stableMessageId ?? '',
      parentId: event.parentId as string | undefined,
      role,
      content: content || undefined,
      thinking: thinking || undefined,
      toolCalls,
      toolCallId: msg.toolCallId as string | undefined,
      toolName: msg.toolName as string | undefined,
      model: msg.model as string | undefined,
      provider: msg.provider as string | undefined,
      stopReason: msg.stopReason as string | undefined,
      // toolResult-only: pi SDK puts isError as a top-level field on the
      // message object (alongside role/toolCallId/toolName), NOT inside
      // content blocks and NOT in stopReason (which is assistant-only).
      // Forwarding it on the delta lets streaming clients mark the matching
      // toolCall as failed on the toolResult message_end event without
      // subscribing to the separate `tool_result` SSE event.
      isError: typeof msg.isError === 'boolean' ? msg.isError : undefined,
    };
  };

  switch (type) {
    case 'message_start':
    case 'message_update':
    case 'message_end': {
      const msg = (event.message as Record<string, unknown> | undefined) ?? {};
      const kind: WorkerEventKind = type === 'message_end' ? 'message_end' : 'message_update';
      return { kind, delta: fromMessage(msg) };
    }
    case 'tool_execution_start':
      return {
        kind: 'tool_call',
        delta: {
          messageId: stableMessageId ?? (event.toolCallId as string | undefined) ?? '',
          role: 'assistant',
          toolCalls: [
            {
              id: (event.toolCallId as string | undefined) ?? '',
              name: (event.toolName as string | undefined) ?? '',
              args: (event.args as Record<string, unknown> | undefined) ?? {},
            },
          ],
        },
      };
    case 'tool_execution_end':
      // pi SDK emits `result` as a ToolResult object `{ content, details, usage, ... }`,
      // NOT the content array directly. extractText() returns '' when given a non-array
      // (early `!Array.isArray` guard), so the previous `extractText(event.result)` here
      // always produced empty result strings. Drill into `.content` to get the actual
      // text blocks (mirrors the message_end for toolResult path in fromMessage).
      const toolResultContent = (event as { result?: { content?: unknown } }).result?.content;
      return {
        kind: 'tool_result',
        delta: {
          messageId: stableMessageId ?? (event.toolCallId as string | undefined) ?? '',
          role: 'assistant',
          content: extractText(toolResultContent) || undefined,
          toolCalls: [
            {
              id: (event.toolCallId as string | undefined) ?? '',
              name: (event.toolName as string | undefined) ?? '',
              args: {},
              result: extractText(toolResultContent),
              isError: Boolean((event as { isError?: unknown }).isError),
            },
          ],
        },
      };
    case 'agent_end':
      return {
        kind: 'agent_end',
        delta: { messageId: 'agent', role: 'assistant' },
      };
    case 'queue_update': {
      // queue_update carries steering + followUp arrays in `event.steering` / `event.followUp`.
      // We return a sentinel delta (so toDelta returns non-null) but the actual payload goes via emit data.
      // The subscribe callback below checks event.type === 'queue_update' and bypasses toDelta.
      return {
        kind: 'queue_update',
        delta: {
          messageId: 'queue',
          role: 'assistant',
          content: '',
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Create a real pi SDK session and wire up event emission.
 */
export async function createSession(
  config: RuntimeConfig,
  sessionId: string,
  emit: EventEmitter,
  callMaster: CallMasterFn,
  existingSessionPath?: string,
): Promise<{ session: PiSessionAdapter; handle: SessionHandle }> {
  const agentDir = process.env.PI_AGENT_DIR ?? defaultAgentDir();
  const acc = new DeltaAccumulator();

  const agentConfig = config.config;
  console.log(`[worker] creating session sessionId=${sessionId} model=${config.model} thinkingLevel=${config.thinkingLevel ?? '(none)'} tools=${agentConfig?.builtinTools?.join(',') ?? '(default)'} cwd=${config.workspacePath}`)

  // If caller supplies an existing session file path, resume that session.
  // Otherwise create a brand new session.
  const sessionManager =
    existingSessionPath && existsSync(existingSessionPath)
      ? SessionManager.open(existingSessionPath, undefined, config.workspacePath)
      : undefined;

  // Create a ModelRuntime for setModel / listAvailableModels (D11, D3).
  const runtime = await ModelRuntime.create({});

  // Build a ResourceLoader that honors agent-supplied systemPrompt / appendSystemPrompt.
  // pi SDK's `CreateAgentSessionOptions` has NO `systemPrompt` field — system prompt
  // has to flow through the resourceLoader. If we don't build our own, pi falls back
  // to its DefaultResourceLoader which only knows about settings.json / discovery.
  // Empty/undefined systemPrompt means "use pi default" — we omit it from options so
  // pi's discoverSystemPromptFile() runs.
  const resourceLoader = new DefaultResourceLoader({
    cwd: config.workspacePath,
    agentDir,
    systemPrompt: agentConfig?.systemPrompt?.trim() ? agentConfig.systemPrompt : undefined,
    appendSystemPrompt: agentConfig?.appendSystemPrompt?.trim() ? [agentConfig.appendSystemPrompt] : undefined,
    // Resource filters based on agent config
    extensionsOverride: agentConfig?.extensions ? (base) => {
      console.log(`[worker] extensionsOverride: before=${base.extensions.length}`);
      base.extensions.forEach(ext => {
        const name = extractExtensionName(ext.path);
        const resolvedName = extractExtensionName(ext.resolvedPath);
        console.log(`  ext path="${ext.path}" resolvedPath="${ext.resolvedPath}" extractedName="${name}" resolvedName="${resolvedName}"`);
      });
      const result = createExtensionsFilter(agentConfig.extensions, config.workspacePath)(base);
      console.log(`[worker] extensionsOverride: after=${result.extensions.length}`);
      return result;
    } : undefined,
    skillsOverride: agentConfig?.skills ? createSkillsFilter(agentConfig.skills) : undefined,
    promptsOverride: agentConfig?.prompts ? createPromptsFilter(agentConfig.prompts) : undefined,
  });
  // Per E: pi SDK's createAgentSession only auto-reloads the resourceLoader when we
  // DON'T pass one in (sdk.js: `if (!resourceLoader) { ... await resourceLoader.reload() }`).
  // Since we pass our own loader in (to honor agent-supplied systemPrompt / appendSystemPrompt),
  // we must reload explicitly. Without this, agentsFiles / skills / appendSystemPrompt
  // stay at their constructor defaults ([]), and AGENTS.md (and other cwd-relative context
  // files) never make it into the system prompt — workers run with the bare default
  // prompt + no skills, regardless of what's on disk.
  await resourceLoader.reload();

  // Resolve the agent's configured model from ModelRegistry so pi SDK uses it
  // instead of falling back to settings.json defaultModel.
  const registry = new ModelRegistry(runtime);
  const agentModelEntry = config.model
    ? (() => {
        const slashIdx = config.model.indexOf('/');
        if (slashIdx > 0) {
          return registry.find(config.model.slice(0, slashIdx), config.model.slice(slashIdx + 1));
        }
        // No slash — try matching by model id alone
        return registry.getAvailable().find((m) => m.id === config.model);
      })()
    : undefined;

  // Build default tools (sendFileToUser, etc.) — injected into every session.
  const customTools = createDefaultTools(sessionId, callMaster);

  const result = await createAgentSession({
    cwd: config.workspacePath,
    agentDir,
    model: agentModelEntry, // undefined → pi SDK falls back to settings.json default
    thinkingLevel: (config.thinkingLevel ?? undefined) as ThinkingLevel | undefined,
    // Don't pass `tools` parameter — let pi SDK use all available tools.
    // When `tools` is passed, it sets `allowedToolNames` which blocks extension tools.
    // builtinTools filtering will be done via session.setActiveToolsByName() after creation.
    sessionManager, // undefined → create new; defined → continue existing
    resourceLoader,
    customTools,
  });

  // Detect thinking capability: pi SDK checks model.reasoning flag.
  // If model not registered in models.json, supportsThinking() returns false
  // and thinkingLevel is silently ignored.
  const realSession = result.session;

  // Apply builtinTools filtering after session creation if configured
  // This doesn't set allowedToolNames, just deactivates specific tools.
  if (agentConfig?.builtinTools !== undefined && agentConfig.builtinTools !== null) {
    const allTools = realSession.getAllTools();
    const builtinToolNames = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
    const activeBuiltinTools = builtinToolNames.filter(t => agentConfig.builtinTools!.includes(t));
    // Also keep extension tools active
    const extensionTools = allTools.filter(t => !builtinToolNames.includes(t.name)).map(t => t.name);
    realSession.setActiveToolsByName([...activeBuiltinTools, ...extensionTools]);
  }

  // ─── Custom systemPrompt takeover ───
  // Per change: custom-systemprompt-takeover. When agent.systemPrompt is configured,
  // pi SDK's customPrompt branch silently drops Available tools / "In addition to..." /
  // tool promptGuidelines — all of which are required for the model to use tools correctly.
  // Worker patches the systemPrompt here so the configured systemPrompt serves as
  // the role/identity, but the runtime meta segments (tools, guidelines, project context,
  // skills) are still appended. Pi documentation segment is excluded (普通项目不需要).
  //
  // Per design: one-shot set on _systemPromptOverride. agent-session.js:286 reads
  // override with `?? _baseSystemPrompt`, so once set this persists across every LLM
  // call without monkey-patching _rebuildSystemPrompt.
  //
  // Caveat: runtime tool-set changes (setActiveToolsByName) won't auto-update the
  // override. Acceptable for the current worker architecture where tool-set is fixed
  // at session-creation time.
  //
  // SDK dependency: _toolPromptSnippets / _toolPromptGuidelines / _systemPromptOverride
  // are `_`-prefixed (private) fields on AgentSession. Tracked for breakage across
  // pi-coding-agent upgrades.
  if (agentConfig?.systemPrompt?.trim()) {
    type SessionWithInternalState = {
      _toolPromptSnippets: Map<string, string>;
      _toolPromptGuidelines: Map<string, string[]>;
      _systemPromptOverride?: string;
      agent: { state: { systemPrompt: string } };
      _resourceLoader: {
        getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
        getSkills(): { skills: Array<{ name: string; description: string; filePath: string; baseDir: string }> };
      };
    };
    const ses = realSession as unknown as SessionWithInternalState;

    const userPrompt = agentConfig.systemPrompt.trim();
    const toolSnippets = [...ses._toolPromptSnippets.entries()];
    const promptGuidelines = [...ses._toolPromptGuidelines.values()].flat();

    let suffix = '';

    // Available tools 列表
    const toolLines = toolSnippets
      .filter(([_, s]) => s)
      .map(([n, s]) => `- ${n}: ${s}`)
      .join('\n');
    if (toolLines) suffix += `\n\nAvailable tools:\n${toolLines}`;

    // "In addition to..." 提示
    suffix += `\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;

    // tool promptGuidelines
    if (promptGuidelines.length > 0) {
      suffix += `\n\nGuidelines:\n${promptGuidelines.map((g) => `- ${g.trim()}`).join('\n')}`;
    }

    // appendSystemPrompt
    if (agentConfig?.appendSystemPrompt?.trim()) {
      suffix += `\n\n${agentConfig.appendSystemPrompt.trim()}`;
    }

    // <project_context> (AGENTS.md 等)
    const agentsFiles = ses._resourceLoader.getAgentsFiles().agentsFiles;
    if (agentsFiles.length > 0) {
      suffix += '\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n';
      for (const af of agentsFiles) {
        suffix += `<project_instructions path="${af.path}">\n${af.content}\n</project_instructions>\n\n`;
      }
      suffix += '</project_context>\n';
    }

    // <available_skills> (复用 SDK 公开 API formatSkillsForPrompt)
    const skills = ses._resourceLoader.getSkills().skills as Skill[];
    const hasRead = toolSnippets.some(([n]) => n === 'read');
    if (skills.length > 0 && hasRead) {
      suffix += '\n\n' + formatSkillsForPrompt(skills);
    }

    // Current working directory
    suffix += `\nCurrent working directory: ${config.workspacePath}`;

    const finalPrompt = userPrompt + suffix;
    ses._systemPromptOverride = finalPrompt;
    ses.agent.state.systemPrompt = finalPrompt;
  }

  type SessionLike = { model?: { reasoning?: boolean }; thinkingLevel?: ThinkingLevel }
  const supportsThinking = !!(realSession as unknown as SessionLike).model?.reasoning
  const effectiveLevel = (realSession as unknown as SessionLike).thinkingLevel
  if (config.thinkingLevel && config.thinkingLevel !== 'off') {
    if (!supportsThinking) {
      console.warn(`[worker] ⚠️ thinkingLevel='${config.thinkingLevel}' requested but model '${config.model}' does NOT support thinking (model.reasoning=false or model not registered in models.json). Thinking blocks will NOT appear in output.`)
    } else {
      console.log(`[worker] thinking enabled: level=${effectiveLevel} (requested=${config.thinkingLevel})`)
    }
  }

  // Worker-assigned message ids (stable across start/update/end for one message).
  let messageCounter = 0;
  let currentMessageId: string | null = null;

  const unsubscribe = realSession.subscribe((event: unknown) => {
    const e = event as { type?: string; message?: { role?: string } };

    // Skip user messages — client already has them via optimistic append.
    if (e.message?.role === 'user') return;

    // queue_update: forward steering + followUp arrays directly (no delta needed).
    if (e.type === 'queue_update') {
      emit({
        event: 'queue_update',
        data: {
          steering: (e as { steering?: readonly string[] }).steering ?? [],
          followUp: (e as { followUp?: readonly string[] }).followUp ?? [],
        },
      });
      return;
    }

    const mapped = mapEventType(e.type);
    if (!mapped) return;

    // Assign a fresh id on message_start; reuse it for update/end of the same message.
    if (e.type === 'message_start') {
      currentMessageId = `msg-${++messageCounter}`;
    }

    const dto = toDelta(event as Record<string, unknown>, currentMessageId);
    if (!dto) return;

    if (mapped === 'message_update') {
      acc.upsert(dto.delta.messageId, dto.delta);
    }
    if (mapped === 'message_end') {
      acc.finish(dto.delta.messageId);
      currentMessageId = null;
    }
    emit({ event: mapped, data: dto.delta });
  });

  const adapter = new PiSessionAdapter(realSession as unknown as AgentSessionLike, unsubscribe, runtime);
  const piPath = realSession.sessionManager.getSessionFile();
  if (!piPath) {
    throw new Error('pi SDK returned no session file path');
  }
  // Actual model the worker will use: read DIRECTLY from the session object —
  // createAgentSession resolved it from the passed model (agent config) or settings.json fallback.
  // This is more accurate than re-resolving from ModelRegistry.
  const realModel = (realSession as unknown as { model?: { provider?: string; id?: string } }).model;
  const model = realModel?.provider && realModel?.id
    ? { provider: realModel.provider, modelId: realModel.id }
    : resolveActualModel(runtime, config.model); // defensive fallback
  const handle: SessionHandle = {
    id: sessionId,
    piSessionPath: piPath,
    model,
    thinkingLevel: (realSession as unknown as { thinkingLevel?: ThinkingLevel }).thinkingLevel ?? null,
  };

  return { session: adapter, handle };
}

/** Minimal interface we need from pi SDK AgentSession. */
interface AgentSessionLike {
  prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void>;
  abort(): Promise<void>;
  setModel(model: Model<any>): Promise<void>;
  setThinkingLevel(level: ThinkingLevel): void;
  setActiveToolsByName(toolNames: string[]): void;
  compact(customInstructions?: string): Promise<unknown>;
  promptTemplates: ReadonlyArray<{ name: string; description: string; filePath: string; sourceInfo?: unknown }>;
  extensionRunner: {
    getRegisteredCommands(): ReadonlyArray<{ name: string; description?: string; sourceInfo?: unknown }>;
    getCommand(name: string): { handler: (args: string, ctx: unknown) => Promise<void> | void } | undefined;
    createCommandContext(): unknown;
  };
  resourceLoader: {
    getSkills(): { skills: ReadonlyArray<{ name: string; description: string; filePath: string; baseDir: string }> };
  };
  sendUserMessage(content: string): Promise<void>;
  sessionManager: { getSessionFile(): string | undefined };
}

import type { Model } from '@earendil-works/pi-ai';

/** Wire-format slash command returned to master/IDE. */
export interface SlashCommandDTO {
  name: string;
  description: string;
  argumentHint?: string;
  source: 'builtin' | 'extension' | 'prompt' | 'skill';
  sourceInfo?: unknown;
}

/** Builtin slash commands exposed in the IDE input box (`/` menu).
 *  Commands NOT in this set are filtered out by `listCommands` (D4 / OQ).
 *  Excluded pi builtins (`settings` / `login` / etc.) belong on the web admin menu.
 *  Metadata hard-coded here because pi SDK doesn't re-export BUILTIN_SLASH_COMMANDS from
 *  dist/index.js (kept in sync with `@earendil-works/pi-coding-agent/dist/core/slash-commands.js`). */
const IDE_EXPOSED_BUILTINS: ReadonlyMap<string, { description: string; argumentHint?: string }> = new Map([
  ['model',     { description: 'Select model', argumentHint: '<provider/model>' }],
  ['thinking',  { description: 'Set thinking level', argumentHint: '<level>' }],
  ['name',      { description: 'Set session display name', argumentHint: '<name>' }],
  ['session',   { description: 'Show session info and stats' }],
  ['compact',   { description: 'Manually compact the session context' }],
  ['hotkeys',   { description: 'Show all keyboard shortcuts' }],
]);

/** Strip YAML front-matter from a template/skill file body. */
function stripFrontmatter(raw: string): string {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? raw.slice(m[0].length).trim() : raw.trim();
}

/** Thin wrapper around the real pi SDK AgentSession. */
export class PiSessionAdapter {
  constructor(
    private readonly real: AgentSessionLike,
    private readonly unsubscribe: () => void,
    private readonly modelRuntime: ModelRuntime,
  ) {}

  async prompt(
    message: string,
    options?: {
      streamingBehavior?: 'steer' | 'followUp';
      images?: Array<{ type: 'image'; mimeType: string; data: string }>;
    },
  ): Promise<void> {
    // Pass through to the underlying AgentSession.prompt — pi SDK accepts
    // `options.images` natively (see AgentSession.d.ts PromptOptions.images).
    await (this.real.prompt as any)(message, options);
  }

  async abort(): Promise<void> {
    await this.real.abort();
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const registry = new ModelRegistry(this.modelRuntime);
    const model = registry.find(provider, modelId);
    if (!model) {
      throw new Error(`Unknown model: ${provider}/${modelId}`);
    }
    await this.real.setModel(model);
  }

  async setThinkingLevel(level: string): Promise<void> {
    this.real.setThinkingLevel(level as ThinkingLevel);
  }

  async setTools(tools: string[]): Promise<void> {
    this.real.setActiveToolsByName(tools);
  }

  /** List slash commands available in this session (4 sources, builtin white-listed). */
  async listCommands(): Promise<SlashCommandDTO[]> {
    const builtins: SlashCommandDTO[] = Array.from(IDE_EXPOSED_BUILTINS.entries()).map(
      ([name, meta]) => ({
        name,
        description: meta.description,
        argumentHint: meta.argumentHint,
        source: 'builtin' as const,
      }),
    );

    const extensions: SlashCommandDTO[] = this.real.extensionRunner
      .getRegisteredCommands()
      .map((c: { name: string; description?: string; sourceInfo?: unknown }) => ({
        name: c.name,
        description: c.description ?? '',
        source: 'extension' as const,
        sourceInfo: c.sourceInfo,
      }));

    const prompts: SlashCommandDTO[] = (this.real.promptTemplates as ReadonlyArray<{
      name: string;
      description: string;
      filePath: string;
      sourceInfo?: unknown;
    }>).map((p) => ({
      name: p.name,
      description: p.description,
      source: 'prompt' as const,
      sourceInfo: p.sourceInfo,
    }));

    const skills: SlashCommandDTO[] = this.real.resourceLoader
      .getSkills().skills
      .map((s: { name: string; description: string; filePath: string; baseDir: string }) => ({
        name: `skill:${s.name}`,
        description: s.description,
        source: 'skill' as const,
        sourceInfo: { filePath: s.filePath, baseDir: s.baseDir },
      }));

    return [...builtins, ...extensions, ...prompts, ...skills];
  }

  /** Dispatch a slash command by name (D4 routing). */
  async dispatchCommand(name: string, args: string): Promise<void> {
    // 1. Skill: prefix → read skill file + wrap in <skill> block + send as user message
    if (name.startsWith('skill:')) {
      const skillName = name.slice('skill:'.length);
      const skill = this.real.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
      if (!skill) throw new Error(`Unknown command: ${name}`);
      const fs = await import('node:fs/promises');
      const raw = await fs.readFile(skill.filePath, 'utf-8');
      const body = stripFrontmatter(raw);
      const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
      const content = args ? `${skillBlock}\n\n${args}` : skillBlock;
      await this.real.sendUserMessage(content);
      return;
    }

    // 2. Prompt template → read file, strip frontmatter, append args, send as user message.
    //    (Simplified: no `$1`/`$2` placeholder substitution — args appended after template body.
    //    pi SDK's full `expandPromptTemplate` is internal; MVP behavior is sufficient.)
    const promptTemplate = (this.real.promptTemplates as ReadonlyArray<{
      name: string;
      description: string;
      filePath: string;
      sourceInfo?: unknown;
    }>).find((p) => p.name === name);
    if (promptTemplate) {
      const fs = await import('node:fs/promises');
      const raw = await fs.readFile(promptTemplate.filePath, 'utf-8');
      const body = stripFrontmatter(raw);
      const content = args ? `${body}\n\n${args}` : body;
      await this.real.sendUserMessage(content);
      return;
    }

    // 3. Builtin: compact
    if (name === 'compact') {
      await this.real.compact();
      return;
    }

    // 4. Extension command → runner
    const cmd = this.real.extensionRunner.getCommand(name);
    if (!cmd) throw new Error(`Unknown command: ${name}`);
    const ctx = this.real.extensionRunner.createCommandContext();
    await cmd.handler(args, ctx as never);
  }

  /** List globally available models (ModelRegistry snapshot). */
  async listAvailableModels(): Promise<Array<{
    provider: string;
    modelId: string;
    displayName: string;
    hasAuth: boolean;
    reasoning?: boolean;
    thinkingLevelMap?: Record<string, string | null>;
  }>> {
    const registry = new ModelRegistry(this.modelRuntime);
    const models = registry.getAvailable();
    return models.map((m) => ({
      provider: m.provider,
      modelId: m.id,
      displayName: m.name || `${m.provider}/${m.id}`,
      hasAuth: registry.hasConfiguredAuth(m),
      reasoning: (m as unknown as { reasoning?: boolean }).reasoning,
      thinkingLevelMap: (m as unknown as { thinkingLevelMap?: Record<string, string | null> }).thinkingLevelMap,
    }));
  }

  /** Compact the session context (C3 / D4). */
  async compact(): Promise<void> {
    await this.real.compact();
  }

  /**
   * Current context-window usage for the active model.
   * Forwards to pi SDK `AgentSession.getContextUsage()` — returns
   * `{ tokens, contextWindow, percent }`, where `tokens` / `percent` may be
   * `null` after a compaction before the next LLM response (SDK can't estimate
   * pre-compaction context size from usage alone).
   */
  async getContextUsage(): Promise<{
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null> {
    const fn = (this.real as unknown as { getContextUsage?: () => unknown }).getContextUsage
    if (typeof fn !== 'function') return null
    const out = fn.call(this.real)
    // SDK typing is loose; coerce defensively.
    if (!out || typeof out !== 'object') return null
    const r = out as { tokens?: unknown; contextWindow?: unknown; percent?: unknown }
    return {
      tokens: typeof r.tokens === 'number' ? r.tokens : null,
      contextWindow: typeof r.contextWindow === 'number' ? r.contextWindow : 0,
      percent: typeof r.percent === 'number' ? r.percent : null,
    }
  }

  getSessionFilePath(): string {
    return this.real.sessionManager.getSessionFile() ?? '';
  }

  /**
   * Returns the current system prompt that will be sent to the LLM on the next turn.
   * - `text`: full system prompt string
   * - `length`: character count
   * - `source`: "override" if worker set `_systemPromptOverride` (per change:
   *   custom-systemprompt-takeover), "default" if pi SDK's default prompt branch.
   *
   * Read from internal AgentSession state. `agent.state.systemPrompt` is updated
   * every turn by `_rebuildSystemPrompt`; we prefer `_systemPromptOverride` (the
   * one-shot override the worker may have set) to reflect what is actually used.
   */
  getSystemPrompt(): { text: string; length: number; source: 'override' | 'default' } {
    type SessionWithInternal = {
      _systemPromptOverride?: string;
      agent: { state: { systemPrompt: string } };
    };
    const real = this.real as unknown as SessionWithInternal;
    const override = real._systemPromptOverride;
    const text = override ?? real.agent.state.systemPrompt ?? '';
    return {
      text,
      length: text.length,
      source: override ? 'override' : 'default',
    };
  }

  cleanup(): void {
    this.unsubscribe();
  }
}