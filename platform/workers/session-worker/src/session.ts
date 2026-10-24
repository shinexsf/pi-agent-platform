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
  type InlineExtension,
  type McpServerConfig,
  type NormalizedBuildSystemPromptOptions,
} from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-ai';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  MessageDeltaDTO,
  MessageUsageDTO,
  MessageRole,
  RuntimeConfig,
  ToolCallDTO,
  AgentConfig,
} from '@pi-agent-platform/shared-types';
import { createExtensionsFilter, createSkillsFilter, createPromptsFilter, extractExtensionName } from './resource-filters.js';
import { groupMcpTools, isMcpToolName, type McpServerGroup } from './mcp-tools.js';
import { resolveBuiltinExtensionInjection } from './builtin-extensions.js';
import { loadSelectedMcpServers } from './mcp-catalog.js';
import { logger } from './logger.js';
import type { WorkerEvent, WorkerEventKind } from '@pi-agent-platform/ipc-protocol';
import { createServerTools, type CallMasterFn } from './tools.js';

export type EventEmitter = (event: Omit<WorkerEvent, 'kind'>) => void;

export interface SessionHandle {
  id: string;
  piSessionPath: string;
  /** Actual model the worker will use (resolved from agent config / pi settings). */
  model: { provider: string; modelId: string } | null;
  /** Active thinking level (from pi SDK AgentSession.thinkingLevel). */
  thinkingLevel: ThinkingLevel | null;
  /** pi-native session display name at creation (sessionManager.getSessionName()).
   *  Master compares it against sessions.title on load (heal, DB wins). */
  sessionName?: string;
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
    logger.warn({ err: e }, 'resolveActualModel failed');
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
    case 'session_info_changed':
      return 'session_info_changed';
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

/** How often coalesced `message_update` snapshots are flushed (change: session-streaming-runtime).
 *  pi emits one `message_update` per provider chunk, each carrying the FULL accumulated
 *  text, so forwarding them 1:1 costs O(n²) bytes and O(n²) client parse work.
 *  Coalescing keeps only the newest snapshot per messageId inside this window. */
const MESSAGE_UPDATE_FLUSH_MS = 60;

/**
 * Coalesces `message_update` deltas per messageId.
 *
 * Contract (spec `session-stream-protocol`): payloads stay "cumulative full text", so
 * dropping intermediate snapshots loses nothing — the newest one already contains them.
 * The FIRST delta of a message is sent immediately (no visible first-token delay) and
 * every non-update event flushes the pending bucket first, so the last characters are
 * never stuck behind the timer.
 */
class DeltaThrottle {
  private pending = new Map<string, MessageDeltaDTO>();
  private timer: NodeJS.Timeout | null = null;
  /** messageIds whose first delta has already been sent. */
  private started = new Set<string>();

  constructor(private readonly send: (delta: MessageDeltaDTO) => void) {}

  push(delta: MessageDeltaDTO): void {
    if (!this.started.has(delta.messageId)) {
      // First delta for this message: flush anything queued, then send right away.
      this.started.add(delta.messageId);
      this.flush();
      this.send(delta);
      return;
    }
    this.pending.set(delta.messageId, delta);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, MESSAGE_UPDATE_FLUSH_MS);
    }
  }

  /** Send every queued snapshot now (order preserved per messageId). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const queued = [...this.pending.values()];
    this.pending.clear();
    for (const delta of queued) this.send(delta);
  }

  /** Forget a finished message so a re-used id starts fresh again. */
  release(messageId: string): void {
    this.pending.delete(messageId);
    this.started.delete(messageId);
  }

  /** Flush and drop the timer (called when the session is disposed). */
  dispose(): void {
    this.flush();
  }
}

/**
 * Extract pi-ai `Usage` into our DTO. Returns undefined when the message carries none
 * (user / toolResult messages) so clients can distinguish "no data" from "zero cost".
 */
function extractUsage(raw: unknown): MessageUsageDTO | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  if (typeof u.input !== 'number' && typeof u.output !== 'number') return undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cost = (u.cost && typeof u.cost === 'object' ? u.cost : {}) as Record<string, unknown>;
  return {
    input: num(u.input),
    output: num(u.output),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    ...(typeof u.reasoning === 'number' ? { reasoning: u.reasoning } : {}),
    totalTokens: num(u.totalTokens),
    cost: {
      input: num(cost.input),
      output: num(cost.output),
      cacheRead: num(cost.cacheRead),
      cacheWrite: num(cost.cacheWrite),
      total: num(cost.total),
    },
  };
}

/**
 * Convert a pi SDK event into a simplified delta DTO.
 * `stableMessageId` is the worker-assigned id kept across start/update/end for one message.
 * Returns null if the event carries no useful payload.
 */
function toDelta(event: Record<string, unknown>, stableMessageId: string | null, startedAt?: number | null): { kind: WorkerEventKind; delta: MessageDeltaDTO } | null {
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
      // Usage is assistant-only in practice (pi-ai `Usage`); toolResult/user messages
      // have none, so the field stays undefined rather than zero-filled.
      usage: role === 'assistant' ? extractUsage(msg.usage) : undefined,
    };
  };

  switch (type) {
    case 'message_start':
    case 'message_update':
    case 'message_end': {
      const msg = (event.message as Record<string, unknown> | undefined) ?? {};
      const kind: WorkerEventKind = type === 'message_end' ? 'message_end' : 'message_update';
      const delta = fromMessage(msg);
      // Wall-clock per-message duration, only meaningful once the message ends.
      if (kind === 'message_end' && typeof startedAt === 'number') {
        delta.durationMs = Math.max(0, Date.now() - startedAt);
      }
      return { kind, delta };
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
              // pi measures `execute()` with a monotonic clock; absent when the tool never ran.
              ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}),
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
 * Shared takeover state: seeded eagerly at session creation (so getSystemPrompt is
 * complete before turn 1) and refreshed by the before_agent_start handler every turn.
 */
interface SystemPromptTakeoverState {
  active: boolean;
  lastPrompt: string | null;
}

/**
 * Build the full custom systemPrompt (change: custom-systemprompt-takeover).
 *
 * Input = pi's public `NormalizedBuildSystemPromptOptions` — fed from the
 * `before_agent_start` event payload each turn (handler path) or from the session's
 * current base options once at creation (eager seed for the getSystemPrompt debug path).
 *
 * Segment order is fixed by spec (worker-system-prompt-customization):
 *   userPrompt → Available tools → "In addition to..." → Guidelines → append →
 *   <project_context> → <available_skills> → cwd
 * and MUST exclude pi's Role definition / hardcoded Guidelines / Pi documentation
 * (that is the entire point of the takeover: pi's customPrompt branch drops the
 * tools/rules sections, we rebuild them here).
 */
function buildTakeoverPrompt(opts: NormalizedBuildSystemPromptOptions): string {
  const userPrompt = (opts.customPrompt ?? '').trim();
  const hidden = new Set(opts.hiddenTools);
  // Visible = active ∧ not prepareLoadout-hidden ∧ has a one-line snippet.
  const visible = opts.selectedTools.filter((n) => !hidden.has(n) && !!opts.toolSnippets[n]);

  let suffix = '';

  // Available tools 列表
  const toolLines = visible.map((n) => `- ${n}: ${opts.toolSnippets[n]}`).join('\n');
  if (toolLines) suffix += `\n\nAvailable tools:\n${toolLines}`;

  // "In addition to..." 提示（字面量，spec 要求恒存在）
  suffix += `\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;

  // tool promptGuidelines（仅当前激活工具的）
  const guidelines = visible.flatMap((n) => opts.toolGuidelines[n] ?? []);
  if (guidelines.length > 0) {
    suffix += `\n\nGuidelines:\n${guidelines.map((g) => `- ${g.trim()}`).join('\n')}`;
  }

  // appendSystemPrompt
  const append = opts.appendSystemPrompt.trim();
  if (append) suffix += `\n\n${append}`;

  // <project_context> (AGENTS.md 等) — whitespace byte-compatible with the 0.84 takeover
  if (opts.contextFiles.length > 0) {
    suffix += '\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n';
    for (const cf of opts.contextFiles) {
      suffix += `<project_instructions path="${cf.path}">\n${cf.content}\n</project_instructions>\n\n`;
    }
    suffix += '</project_context>\n';
  }

  // <available_skills> (复用 SDK 公开 API formatSkillsForPrompt；需 read 处于激活态)
  if (opts.skills.length > 0 && visible.includes('read')) {
    suffix += '\n\n' + formatSkillsForPrompt(opts.skills);
  }

  // Current working directory（最后一段）
  suffix += `\nCurrent working directory: ${opts.cwd}`;

  return userPrompt + suffix;
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
  logger.info(
    {
      sessionId,
      model: config.model,
      thinkingLevel: config.thinkingLevel ?? '(none)',
      tools: agentConfig?.builtinTools?.join(',') ?? '(default)',
      cwd: config.workspacePath,
    },
    'creating session',
  );

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
  //
  // Takeover wiring (change: custom-systemprompt-takeover, pi >= 1.1.0): when
  // agent.systemPrompt is set we also register an inline extension whose
  // before_agent_start handler rebuilds the full prompt from the event payload and
  // returns it as `{ systemPrompt }` (forced prompt projection). Replaces the removed
  // `_systemPromptOverride` private-field hack — see buildTakeoverPrompt() below.
  const takeoverState: SystemPromptTakeoverState = {
    active: !!agentConfig?.systemPrompt?.trim(),
    lastPrompt: null,
  };
  const takeoverExtension: InlineExtension | undefined = takeoverState.active
    ? {
        name: 'worker-system-prompt-takeover',
        hidden: true,
        factory: (pi) => {
          pi.on('before_agent_start', (event) => {
            try {
              const built = buildTakeoverPrompt(event.systemPromptOptions);
              takeoverState.lastPrompt = built;
              return { systemPrompt: built };
            } catch (err) {
              // Never break the turn: fall through to pi's own prompt assembly.
              logger.error({ err }, 'takeover handler failed; using pi default prompt for this turn');
              return undefined;
            }
          });
        },
      }
    : undefined;

  // ─── Built-in extension injection (change: builtin-tools-unified-management) ───
  // Two independent inputs now (change: mcp-as-first-class-capability):
  //   - `builtinTools` names TOOLS; codemode / tool_search are extension-provided tools, so
  //     naming one loads the matching `builtin:<ext>` (see builtin-extensions.ts).
  //   - `mcp.enabled` is the MCP capability switch: it loads `builtin:mcp` plus the codemode /
  //     tool_search dependencies (a server's default `exposure: "codemode"` needs them).
  // Injection and activation share ONE list, so "injected but not whitelisted" cannot happen.
  // A legacy `'mcp'` entry in builtinTools is ignored — MCP is never enabled via the tool list.
  const mcpSelection = agentConfig?.mcp?.enabled === true
    ? loadSelectedMcpServers({
        agentDir,
        cwd: config.workspacePath,
        selections: agentConfig.mcp?.servers,
      })
    : undefined;
  const mcpActive = (mcpSelection?.servers.length ?? 0) > 0;
  if (agentConfig?.mcp?.enabled === true && !mcpActive) {
    logger.warn(
      { catalogPath: mcpSelection?.catalogPath, errors: mcpSelection?.errors },
      'mcp enabled but no server resolved; mcp stays off (select servers from the platform catalog)',
    );
  }
  const builtinInjection = await resolveBuiltinExtensionInjection({
    builtinTools: agentConfig?.builtinTools,
    mcpEnabled: mcpActive,
  });

  // Registration of the SELECTED catalog servers. This has to happen while extensions load:
  // pi's `mcp` extension reads `pi.getMcpServers()` on `session_start` and connects whatever is
  // registered there. Inline (not builtin) because the code lives here, not in pi's dist.
  const mcpCatalogExtension: InlineExtension | undefined = mcpActive
    ? {
        name: 'platform:mcp-catalog',
        hidden: true,
        factory: (pi) => {
          const registered: string[] = [];
          for (const server of mcpSelection?.servers ?? []) {
            try {
              pi.registerMcpServer(server.name, server.config as unknown as McpServerConfig);
              registered.push(server.name);
            } catch (err) {
              // One broken definition must not take the session down with it.
              logger.error({ err, server: server.name }, 'registerMcpServer failed; server skipped');
            }
          }
          logger.info(
            { registered, selected: agentConfig?.mcp?.servers, catalogPath: mcpSelection?.catalogPath },
            'registered MCP servers from platform catalog',
          );
        },
      }
    : undefined;

  const extensionFactories: InlineExtension[] = [
    ...(takeoverExtension ? [takeoverExtension] : []),
    ...(mcpCatalogExtension ? [mcpCatalogExtension] : []),
    ...(builtinInjection?.factories ?? []),
  ];

  const resourceLoader = new DefaultResourceLoader({
    cwd: config.workspacePath,
    agentDir,
    systemPrompt: agentConfig?.systemPrompt?.trim() ? agentConfig.systemPrompt : undefined,
    appendSystemPrompt: agentConfig?.appendSystemPrompt?.trim() ? [agentConfig.appendSystemPrompt] : undefined,
    // Inline takeover extension — loaded BEFORE extensionsOverride runs, hence the
    // `<inline:` exemption inside createExtensionsFilter (resource-filters.ts).
    // Built-in extension factories (codemode/tool-search/mcp) ride along here; the matching
    // `builtin:<ext>` load paths go into additionalExtensionPaths below (both are required).
    extensionFactories: extensionFactories.length > 0 ? extensionFactories : undefined,
    // Triggers loading of pi's built-in extensions (resource-loader merges these into the
    // extension path list and looks the factory up in the table built from extensionFactories).
    additionalExtensionPaths: builtinInjection?.extensionPaths,
    // Resource filters based on agent config
    extensionsOverride: agentConfig?.extensions ? (base) => {
      logger.debug({ count: base.extensions.length }, 'extensionsOverride: before');
      base.extensions.forEach(ext => {
        const name = extractExtensionName(ext.path);
        const resolvedName = extractExtensionName(ext.resolvedPath);
        logger.debug(
          { extPath: ext.path, resolvedPath: ext.resolvedPath, extractedName: name, resolvedName },
          'extensionsOverride: ext',
        );
      });
      const result = createExtensionsFilter(
        agentConfig.extensions,
        config.workspacePath,
        builtinInjection?.extensionPaths,
      )(base);
      logger.debug({ count: result.extensions.length }, 'extensionsOverride: after');
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

  // Build server-side tools (sendFileToUser / callServer) — gated by
  // AgentConfig.serverBuiltinTools (default: sendFileToUser only; callServer opt-in).
  // capabilityIndex (master-pushed) embeds the capability index into the
  // callServer description for zero-round-trip first use.
  const customTools = createServerTools(sessionId, callMaster, {
    serverBuiltinTools: agentConfig?.serverBuiltinTools,
    capabilityIndex: config.capabilityIndex,
  });

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

  // ─── Extension lifecycle bind (REQUIRED when using extensions) ───
  // `session_start` / `session_shutdown` are emitted ONLY from AgentSession.bindExtensions()
  // (agent-session.js bindExtensions() → runner.emit(_sessionStartEvent)) — createAgentSession
  // does NOT call it; only TUI/print/rpc modes do. Without this call, extensions that
  // initialize in a session_start handler never run — e.g. pi-mcp-adapter stays state=null
  // and every mcp tool returns "MCP not initialized". Official contract: docs/sdk.md
  // ("if you use extensions, call runtime.session.bindExtensions(...) again for the new
  // session") + examples/sdk/13-session-runtime.ts (`await session.bindExtensions({})`).
  //
  // Bindings rationale:
  // - mode "rpc": ExtensionMode = "tui" | "rpc" | "json" | "print" (no "sdk" value);
  //   worker is headless + request/response, "rpc" is the closest deterministic value.
  // - shutdownHandler noop: session.reload() only re-emits session_start when hasBindings
  //   is truthy (requires uiContext || commandContextActions || shutdownHandler || onError);
  //   keep one binding set so a future reload re-initializes extensions.
  // - Placed BEFORE setActiveToolsByName filtering and the systemPrompt takeover below so
  //   resources_discover injections (extendResourcesFromExtensions) are visible to both.
  await realSession.bindExtensions({
    mode: 'rpc',
    shutdownHandler: () => {},
  });

  // Diagnostic: what actually made it into the resource set. Run with LOG_LEVEL=debug.
  // Matters because two whitelists apply to resources and BOTH have "always keep" exemptions:
  // - extensions: agentConfig.extensions filters package extensions (list is resolved in
  //   `mergeWithGlobalDefaults` from `~/.pi/server/config.json` defaultExtensions).
  // - skills: agentConfig.skills filters skills, but project (`scope: project`) and
  //   extension-injected (`scope: temporary`) skills are always kept (resource-filters.ts).
  // An extension that contributes skills via `resources_discover` (e.g. @amaster.ai/pi-lark)
  // only shows up in the skills list when the extension itself was loaded.
  {
    const extensions = resourceLoader.getExtensions();
    const skills = resourceLoader.getSkills();
    const byScope = skills.skills.reduce<Record<string, number>>((acc, skill) => {
      const scope = skill.sourceInfo?.scope ?? 'unknown';
      acc[scope] = (acc[scope] ?? 0) + 1;
      return acc;
    }, {});
    logger.debug(
      {
        agentDir,
        cwd: config.workspacePath,
        extensions: extensions.extensions.map((ext) => ({
          path: ext.path,
          tools: ext.tools ? [...ext.tools.keys()] : [],
        })),
        extensionErrors: extensions.errors,
        extensionWarnings: extensions.warnings,
        skillsByScope: byScope,
        skills: skills.skills.map((skill) => `${skill.name}@${skill.sourceInfo?.scope ?? '?'}`),
        skillDiagnostics: skills.diagnostics,
      },
      'resources after bindExtensions',
    );
  }

  // Apply builtinTools filtering after session creation if configured
  // This doesn't set allowedToolNames, just deactivates specific tools.
  if (agentConfig?.builtinTools !== undefined && agentConfig.builtinTools !== null) {
    const allTools = realSession.getAllTools();
    // Classify by pi's own marker `sourceInfo.source === 'builtin'` instead of a hardcoded
    // name list: the old 0.84-era list missed `powershell` (added in pi 0.86), which got
    // misclassified as an "extension tool" and force-activated — C2 of upgrade-pi-sdk-1-1-0.
    // Config gates builtin tools only; non-builtins (sdk custom tools + extension tools)
    // stay active, same as before.
    //
    // Built-in EXTENSIONS (codemode / tool_search / mcp) register their tools with
    // sourceInfo.source === 'builtin' too (their extension path is `builtin:<ext>`), so this
    // single filter governs both kinds — no extra branch needed (P0-E3 of
    // builtin-tools-unified-management). They are only injected when named here, so
    // "loaded but not activated" cannot happen.
    const activeBuiltinTools = allTools
      .filter(
        (t) =>
          t.sourceInfo?.source === 'builtin' &&
          (builtinInjection?.toolNames ?? agentConfig.builtinTools!).includes(t.name),
      )
      .map((t) => t.name);
    // MCP tools carry `sourceInfo.source === 'builtin'` too (their extension path is
    // `builtin:mcp`), but they are NOT whitelisted tools: pi owns their visibility via each
    // server's `exposure`. Filtering them out here would silently disable `direct`-exposure
    // servers, so they are kept regardless (change: mcp-as-first-class-capability).
    const nonBuiltinTools = allTools
      .filter((t) => t.sourceInfo?.source !== 'builtin' || isMcpToolName(t.name))
      .map((t) => t.name);
    realSession.setActiveToolsByName([...activeBuiltinTools, ...nonBuiltinTools]);
  }

  // ─── Custom systemPrompt takeover (pi >= 1.1.0) ───
  // Per change: custom-systemprompt-takeover. When agent.systemPrompt is configured,
  // pi SDK's customPrompt branch silently drops Available tools / "In addition to..." /
  // tool promptGuidelines — all of which are required for the model to use tools correctly.
  //
  // The live mechanism is the inline extension registered above: its before_agent_start
  // handler rebuilds the prompt from the public event payload EVERY turn and returns
  // `{ systemPrompt }` (forced prompt projection) — so tool-set changes are picked up
  // automatically (the old one-shot `_systemPromptOverride` hack could not).
  //
  // This block only SEEDS takeoverState.lastPrompt before the first turn, because the
  // server calls getSystemPrompt right after session creation (cacheSystemPrompt for
  // /:id/context). It reads the session's private `_baseSystemPromptOptions` — the same
  // normalized options the handler receives — wrapped in try/catch; on failure we degrade
  // to the public `session.systemPrompt` getter inside getSystemPrompt() and warn.
  if (takeoverState.active) {
    type SessionWithBaseOptions = {
      _baseSystemPromptOptions?: NormalizedBuildSystemPromptOptions;
    };
    try {
      const base = (realSession as unknown as SessionWithBaseOptions)._baseSystemPromptOptions;
      if (!base) throw new Error('_baseSystemPromptOptions not available');
      takeoverState.lastPrompt = buildTakeoverPrompt(base);
      logger.debug({ length: takeoverState.lastPrompt.length }, 'takeover prompt seeded (pre-first-turn)');
    } catch (err) {
      // Spec: degrade to public getter + warn; IPC must not throw.
      logger.warn({ err }, 'takeover eager seed failed; getSystemPrompt will fall back to session.systemPrompt');
    }
  }

  type SessionLike = { model?: { reasoning?: boolean }; thinkingLevel?: ThinkingLevel }
  const supportsThinking = !!(realSession as unknown as SessionLike).model?.reasoning
  const effectiveLevel = (realSession as unknown as SessionLike).thinkingLevel
  if (config.thinkingLevel && config.thinkingLevel !== 'off') {
    if (!supportsThinking) {
      logger.warn(
        { thinkingLevel: config.thinkingLevel, model: config.model },
        'thinkingLevel requested but model does NOT support thinking (model.reasoning=false or not registered in models.json); thinking blocks will NOT appear in output',
      )
    } else {
      logger.info({ level: effectiveLevel, requested: config.thinkingLevel }, 'thinking enabled');
    }
  }

  // Worker-assigned message ids (stable across start/update/end for one message).
  let messageCounter = 0;
  let currentMessageId: string | null = null;
  /** Wall-clock start of the message being produced (for assistant `durationMs`). */
  let messageStartedAt: number | null = null;

  // Coalesce `message_update` at the source: one event stream feeds SSE *and* the IM
  // gateway, so thinning here benefits every consumer (spec `session-stream-protocol`).
  const throttle = new DeltaThrottle((delta) => {
    emit({ event: 'message_update', data: delta });
  });

  const unsubscribe = realSession.subscribe((event: unknown) => {
    const e = event as { type?: string; message?: { role?: string } };

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

    // Lifecycle events carry no message delta. Forwarded under pi's own names
    // (agent_start / agent_settled) so clients get an authoritative
    // running/idle signal instead of guessing from message events (design D2).
    if (e.type === 'agent_start') {
      messageStartedAt = Date.now();
      throttle.flush();
      emit({ event: 'agent_start', data: { startedAt: messageStartedAt } });
      return;
    }
    if (e.type === 'agent_settled') {
      messageStartedAt = null;
      throttle.flush();
      emit({
        event: 'agent_settled',
        data: { aborted: Boolean((e as { aborted?: boolean }).aborted) },
      });
      return;
    }
    // turn_start only refreshes the wall clock used for assistant `durationMs`.
    if (e.type === 'turn_start') {
      messageStartedAt = Date.now();
      return;
    }

    const mapped = mapEventType(e.type);
    if (!mapped) return;

    // session_info_changed: not a message event — no DTO; forward the raw name.
    // Master consumes it to sync sessions.title (session-title-sync).
    if (mapped === 'session_info_changed') {
      emit({ event: 'session_info_changed', data: { name: (e as { name?: string }).name } });
      return;
    }

    // Assign a fresh id on message_start; reuse it for update/end of the same message.
    if (e.type === 'message_start') {
      currentMessageId = `msg-${++messageCounter}`;
      messageStartedAt = Date.now();
    }

    const dto = toDelta(event as Record<string, unknown>, currentMessageId, messageStartedAt);
    if (!dto) return;

    if (mapped === 'message_update') {
      acc.upsert(dto.delta.messageId, dto.delta);
      throttle.push(dto.delta); // first delta immediate, rest coalesced
      return;
    }

    // Every other event is a flush boundary: queued text must reach the client
    // before the event that closes it (no lost tail characters).
    throttle.flush();
    if (mapped === 'message_end') {
      acc.finish(dto.delta.messageId);
      throttle.release(dto.delta.messageId);
      currentMessageId = null;
    }
    emit({ event: mapped, data: dto.delta });
  });

  const adapter = new PiSessionAdapter(
    realSession as unknown as AgentSessionLike,
    () => {
      // Flush pending snapshots before detaching so nothing is dropped on dispose.
      throttle.dispose();
      unsubscribe();
    },
    runtime,
    takeoverState,
  );
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
    sessionName:
      (realSession.sessionManager as { getSessionName?: () => string | undefined }).getSessionName?.() ?? undefined,
  };

  return { session: adapter, handle };
}

/** Minimal interface we need from pi SDK AgentSession. */
interface AgentSessionLike {
  prompt(text: string, options?: { streamingBehavior?: 'steer' | 'followUp' }): Promise<void>;
  abort(): Promise<void>;
  /** pi >= 1.1.0: public getter — current effective system prompt (forced prompt while a run holds one). */
  readonly systemPrompt?: string;
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
    getExtensions(): { extensions: Array<{ path: string; hidden?: boolean; commands: Map<string, unknown>; tools: Map<string, unknown> }> };
  };
  getAllTools(): Array<{
    name: string;
    description: string;
    exposure?: 'direct' | 'model-only' | 'codemode' | 'deferred' | 'hidden';
    sourceInfo: { path: string; source: string };
  }>;
  /** pi >= 1.1.0: names of the tools currently active in the session. */
  getActiveToolNames(): string[];
  sendUserMessage(content: string): Promise<void>;
  setSessionName(name: string): void;
  sessionManager: { getSessionFile(): string | undefined; getSessionName?(): string | undefined };
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
    /** Shared with the takeover inline extension (seed at creation + refreshed per turn). */
    private readonly takeover: SystemPromptTakeoverState,
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

  /** Set the pi-native session display name — appends a `session_info` entry to
   *  the jsonl and emits `session_info_changed` (sync, before any IPC response). */
  setSessionName(name: string): void {
    this.real.setSessionName(name);
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
   * Returns categorized resources (prompts, skills, extensions, tools) available in this session.
   * Unlike listCommands() which returns a flat mixed list of SlashCommandDTOs,
   * this returns resources grouped by type with full metadata.
   */
  getSessionResources(): {
    prompts: Array<{ name: string; description: string; filePath: string }>;
    skills: Array<{ name: string; description: string; filePath: string; baseDir: string }>;
    extensions: Array<{ name: string; path: string; commandCount: number; toolCount: number }>;
    tools: Array<{
      name: string;
      description: string;
      source: string;
      sourceType: 'builtin' | 'extension' | 'sdk';
      exposure: 'direct' | 'model-only' | 'codemode' | 'deferred' | 'hidden';
      active: boolean;
    }>;
    mcpServers: McpServerGroup<{
      name: string;
      description: string;
      exposure: string;
      active: boolean;
    }>[];
  } {
    const prompts = (this.real.promptTemplates as ReadonlyArray<{
      name: string;
      description: string;
      filePath: string;
    }>).map((p) => ({
      name: p.name,
      description: p.description,
      filePath: p.filePath,
    }));

    const skills = this.real.resourceLoader
      .getSkills().skills
      .map((s: { name: string; description: string; filePath: string; baseDir: string }) => ({
        name: s.name,
        description: s.description,
        filePath: s.filePath,
        baseDir: s.baseDir,
      }));

    // Extensions: from resourceLoader, each extension has path + command/tool counts
    const extensionsResult = this.real.resourceLoader.getExtensions();
    const extensions = (extensionsResult.extensions as Array<{
      path: string;
      hidden?: boolean;
      sourceInfo?: { source: string };
      commands: Map<string, unknown>;
      tools: Map<string, unknown>;
    }>)
      .filter((e) => !e.hidden)
      .map((e) => ({
        // Use sourceInfo.source (package name like "npm:pi-mcp-adapter") as display name.
        // Fallback to parent directory name if sourceInfo.source is empty.
        name: e.sourceInfo?.source
          || e.path.split(/[/\\]/).slice(-2, -1).pop()
          || e.path.split(/[/\\]/).pop()?.replace(/\.(ts|js)$/, '')
          || e.path,
        path: e.path,
        commandCount: e.commands.size,
        toolCount: e.tools.size,
      }));

    // Tools: `getAllTools()` returns every registered tool (active or not) together with its
    // `exposure` and `sourceInfo`. `sourceInfo.source` is useless for classification — pi sets it
    // to the literal "builtin" for BOTH the core tools and everything a built-in extension
    // registers (mcp / codemode / tool-search). The real discriminator is `sourceInfo.path`:
    //
    //   builtin:read            → core tool
    //   builtin:mcp             → tool registered by the built-in `mcp` extension
    //   <sdk:sendFileToUser>    → tool the worker registered itself
    //   /abs/path/xxx.ts        → regular extension (source = package label)
    const CORE_TOOL_NAMES = new Set(['read', 'bash', 'edit', 'write', 'find', 'grep', 'ls', 'powershell']);
    // pi ships these as built-in *extensions*, but they are pi's own tools (not external vendors),
    // so they read as `builtin` in the UI.
    const PI_OWN_EXTENSIONS = new Set(['codemode', 'tool-search']);
    const BUILTIN_PREFIX = 'builtin:';
    const activeNames = new Set(this.real.getActiveToolNames());
    const allTools = this.real.getAllTools();

    // MCP tools are reported per server in `mcpServers`, never flat in `tools` (change:
    // mcp-as-first-class-capability).
    const mcpTools = allTools.filter((t) => isMcpToolName(t.name));
    const nonMcpTools = allTools.filter((t) => !isMcpToolName(t.name));
    const mcpServers = groupMcpTools(
      mcpTools.map((t) => ({
        name: t.name,
        description: t.description,
        exposure: t.exposure ?? 'direct',
        active: activeNames.has(t.name),
      })),
    );

    const tools = nonMcpTools.map((t) => {
      const path = t.sourceInfo?.path ?? '';
      const exposure = t.exposure ?? 'direct';
      let sourceType: 'builtin' | 'extension' | 'sdk';
      let source: string;

      if (path.startsWith(BUILTIN_PREFIX)) {
        const slot = path.slice(BUILTIN_PREFIX.length);
        if (CORE_TOOL_NAMES.has(slot) || PI_OWN_EXTENSIONS.has(slot)) {
          sourceType = 'builtin';
          source = 'builtin';
        } else {
          // Any other built-in extension slot: the slot IS the extension name (it is never a tool
          // name), so the badge reads like the extension.
          sourceType = 'extension';
          source = slot;
        }
      } else if (path.startsWith('<sdk:')) {
        sourceType = 'sdk';
        source = 'platform';
      } else {
        sourceType = 'extension';
        source = t.sourceInfo?.source || path.split(/[/\\]/).slice(-2, -1).pop() || path;
      }

      return {
        name: t.name,
        description: t.description,
        source,
        sourceType,
        exposure,
        active: activeNames.has(t.name),
      };
    });

    return { prompts, skills, extensions, tools, mcpServers };
  }

  /**
   * Returns the current system prompt that will be sent to the LLM on the next turn.
   * - `text`: full system prompt string
   * - `length`: character count
   * - `source`: "override" when the worker takeover is active (agent.systemPrompt configured,
   *   per change custom-systemprompt-takeover), "default" for pi's own prompt branch.
   *
   * pi 1.1.0: `_systemPromptOverride` was removed and `agent.state.systemPrompt` became a
   * read-only getter, so we read the shared takeover state (seeded at creation, refreshed
   * by the before_agent_start handler every turn). Fallback: the public `session.systemPrompt`
   * getter + warn — the IPC call MUST NOT throw (server /:id/context only omits the field).
   */
  getSystemPrompt(): { text: string; length: number; source: 'override' | 'default' } {
    if (this.takeover.active) {
      const cached = this.takeover.lastPrompt;
      if (cached !== null) {
        return { text: cached, length: cached.length, source: 'override' };
      }
      // Eager seed failed — degrade to the public getter (may lack takeover segments until the first turn).
      const text = this.readPublicSystemPrompt();
      return { text, length: text.length, source: 'override' };
    }
    const text = this.readPublicSystemPrompt();
    return { text, length: text.length, source: 'default' };
  }

  /** Public `session.systemPrompt` getter (pi >= 1.1.0); never throws. */
  private readPublicSystemPrompt(): string {
    try {
      return this.real.systemPrompt ?? '';
    } catch (err) {
      logger.warn({ err }, 'session.systemPrompt getter failed');
      return '';
    }
  }

  cleanup(): void {
    this.unsubscribe();
  }
}