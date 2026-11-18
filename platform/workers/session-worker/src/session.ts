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
import { pathToFileURL } from 'node:url';
import type { RuntimeConfig, AgentConfig } from '@pi-agent-platform/shared-types';
import { SYSTEM_EVENT_PROMPT_NOTICE } from '@pi-agent-platform/shared-types';
import { createExtensionsFilter, createSkillsFilter, createPromptsFilter, extractExtensionName } from './resource-filters.js';
import { groupMcpTools, isMcpToolName, type McpServerGroup } from './mcp-tools.js';
import { resolveBuiltinExtensionInjection } from './builtin-extensions.js';
import { loadSelectedMcpServers } from './mcp-catalog.js';
import { logger } from './logger.js';

/**
 * 浏览器 `emit` 的分发入口；返回插件是否注册了处理器。
 *
 * 走的是 worker 侧方法注册表（`plugin.<id>.emit`）——与 master 主动调这条路
 * 完全同一条分发路径，没有单独的"插件消息通道"。
 */
export async function emitToPluginMessage(pluginId: string, name: string, data: unknown): Promise<boolean> {
  if (!hasPluginMethod(pluginId, 'emit')) return false;
  try {
    await callPluginMethod(pluginId, 'emit', [{ name, data }]);
    return true;
  } catch (err) {
    logger.error({ pluginId, name, err: String(err) }, 'plugin emit handler failed');
    return false;
  }
}
import type { WorkerEvent, WorkerEventKind, WorkerPluginSpec } from '@pi-agent-platform/ipc-protocol';
import type { PluginWorkerBridge } from '@pi-agent-platform/plugin-types';
import { createServerTools, type CallMasterFn } from './tools.js';
import { callPluginMethod, forwardRegistry, hasPluginMethod, registerPluginMethod } from './methods.js';

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

/**
 * 合并 `message_update` 的原生快照（无损）。
 *
 * pi 每收到一个 provider chunk 就发一条 `message_update`，载荷里带的是**到目前为止
 * 的完整消息**，所以 1:1 转发是 O(n²) 字节 + O(n²) 客户端解析。合并只保留每个
 * message 在窗口内的最新快照——载荷本身已经是累积全量，丢中间态不丢信息。
 *
 * 判据：合并**不改事件说了什么**，只丢掉被后续快照覆盖的中间态。任何"决定给谁看
 * 什么"的转换（打 id、提文本、改名、算时长）都不在这里，那属于投影侧。
 */
/** 合并窗口：多久把排队中的最新快照发出去（毫秒）。 */
const MESSAGE_UPDATE_FLUSH_MS = 60;

class DeltaThrottle {
  private pending = new Map<string, WorkerEvent>();
  private timer: NodeJS.Timeout | null = null;
  /** messageIds whose first snapshot has already been sent. */
  private started = new Set<string>();

  constructor(private readonly send: (event: WorkerEvent) => void) {}

  /** Queue one raw `message_update` envelope keyed by the message it belongs to. */
  push(messageId: string, event: WorkerEvent): void {
    if (!this.started.has(messageId)) {
      // First snapshot of this message: flush anything queued, then send right away
      // (no visible first-token delay).
      this.started.add(messageId);
      this.flush();
      this.send(event);
      return;
    }
    this.pending.set(messageId, event);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, MESSAGE_UPDATE_FLUSH_MS);
    }
  }

  /** Send every queued snapshot now (order preserved per message). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const queued = [...this.pending.values()];
    this.pending.clear();
    for (const event of queued) this.send(event);
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
 *
 * Takes the ONE payload master sends (`RuntimeConfig`): `sessionId` / `model` /
 * `thinkingLevel` / `config` / `existingSessionPath` are the session-row snapshot,
 * `workspacePath` / `capabilityIndex` are platform-injected, `plugins` is derived.
 */
export async function createSession(
  payload: RuntimeConfig,
  emit: EventEmitter,
  callMaster: CallMasterFn,
): Promise<{ session: PiSessionAdapter; handle: SessionHandle }> {
  const config = payload;
  const sessionId = payload.sessionId;
  const existingSessionPath = payload.existingSessionPath;
  const plugins = payload.plugins;
  const agentDir = process.env.PI_AGENT_DIR ?? defaultAgentDir();

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

  // ---- 插件 facet（change: plugin-mechanism，骨架）--------------------------------
  // 下发的是**完整**插件集合（含 `enabled:false` + `reason`），使单会话日志能回答
  // "为什么这个插件没装载"。只加载 `enabled` 条目；任一条失败只让该 facet 不可用，
  // 不得影响会话。
  for (const p of plugins ?? []) {
    if (!p.enabled) {
      logger.debug({ sessionId, pluginId: p.id, reason: p.reason }, 'plugin not loaded for session');
    }
  }
  const enabledPlugins = (plugins ?? []).filter((p) => p.enabled);

  /** 每个插件的桥：平台与插件之间只交换纯数据 + 方法注册，插件不碰裸 IPC。 */
  const bridgeFor = (pluginId: string): PluginWorkerBridge => ({
    pluginId,
    emit(name, data) {
      emit({ event: 'plugin_event', data: { pluginId, name, data } });
    },
    log(level, message, extra) {
      logger[level]({ pluginId, ...extra }, message);
    },
    registerMethod(name, handler) {
      // 封装层职责 1（拼前缀）：插件只说 name，`plugin.<id>.` 由这里补。
      const ok = registerPluginMethod(pluginId, name, (args) =>
        handler((args[0] ?? {}) as unknown),
      );
      if (!ok) {
        logger.error(
          { pluginId, name, rejected: forwardRegistry.rejected().slice(-1)[0] },
          'plugin method registration rejected',
        );
      }
    },
    async call(method, args) {
      // 封装层职责 3（限制可调面）：只能走反向表。正向方法名在这里没有意义，
      // master 侧的反向注册表会以 `unknown method` 拒掉。
      return callMaster(method, args ?? []);
    },
  });

  // extension facet：用 inline factory 包装，既能把 bridge 作为第二参数注入，
  // 又天然落进 `<inline:` 豁免集（不受 agent extensions 白名单过滤）。
  const pluginExtensionFactories: InlineExtension[] = enabledPlugins
    .filter((p) => p.extensionPath)
    .map((p) => ({
      name: `plugin:${p.id}`,
      hidden: true,
      factory: async (pi) => {
        try {
          const mod = (await import(pathToFileURL(p.extensionPath as string).href)) as {
            default?: unknown;
            extension?: unknown;
            activate?: unknown;
          };
          const fn = mod.default ?? mod.extension ?? mod.activate;
          if (typeof fn !== 'function') throw new Error('extension facet 未导出默认工厂函数');
          await (fn as (pi: unknown, ctx: unknown) => unknown)(pi, { bridge: bridgeFor(p.id) });
          logger.info({ pluginId: p.id }, 'extension facet loaded');
        } catch (err) {
          logger.error({ pluginId: p.id, err: String(err) }, 'extension facet failed to load (session continues)');
        }
      },
    }));

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
    ...pluginExtensionFactories,
  ];

  // Server-shipped skills (change: server-builtin-skills). The catalogue lives inside the
  // installed server package; master passes its location via env and the *selection* via
  // `config.serverBuiltinSkills` (explicit list, [] = all off). Only the selected dirs are
  // injected, so nothing unselected can leak through the temporary-scope exemption below.
  const serverBuiltinSkillsDir = process.env.PI_SERVER_BUILTIN_SKILLS_DIR?.trim();
  const selectedBuiltinSkills = agentConfig?.serverBuiltinSkills ?? [];
  const serverBuiltinSkillPaths: string[] = [];
  if (selectedBuiltinSkills.length > 0) {
    if (!serverBuiltinSkillsDir) {
      logger.warn(
        { sessionId, selected: selectedBuiltinSkills },
        'serverBuiltinSkills configured but PI_SERVER_BUILTIN_SKILLS_DIR is empty — nothing injected',
      );
    } else {
      for (const name of selectedBuiltinSkills) {
        const dir = join(serverBuiltinSkillsDir, name);
        if (existsSync(join(dir, 'SKILL.md'))) serverBuiltinSkillPaths.push(dir);
        else logger.warn({ sessionId, name, dir }, 'serverBuiltinSkill not found in this release — skipped');
      }
    }
  }

  const resourceLoader = new DefaultResourceLoader({
    cwd: config.workspacePath,
    agentDir,
    systemPrompt: agentConfig?.systemPrompt?.trim() ? agentConfig.systemPrompt : undefined,
    // Platform-level notice FIRST (change: trigger-scheduling): every agent must
    // know what `<system-event>` means, independent of its own append prompt.
    // One line, one contract — new envelope `kind`s never touch this.
    appendSystemPrompt: [
      SYSTEM_EVENT_PROMPT_NOTICE,
      ...(agentConfig?.appendSystemPrompt?.trim() ? [agentConfig.appendSystemPrompt] : []),
    ],
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
    // Server-shipped skills ride in as extra paths → pi classifies them `temporary`, which
    // `createSkillsFilter` keeps unconditionally. That is the contract, not an oversight:
    // the user's `skills` whitelist must not be able to kill a platform skill, and it must
    // not be the switch for one either (that is `serverBuiltinSkills`). Do NOT add a special
    // case for builtin skills to resource-filters.ts.
    additionalSkillPaths: serverBuiltinSkillPaths.length > 0 ? serverBuiltinSkillPaths : undefined,
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

  // worker facet：与 extension facet 不同，它不是 pi 扩展，只是“同进程的旁观者”，
  // 只能通过 bridge 看事件/发事件。失败同样只隔离自己。
  for (const p of enabledPlugins) {
    if (!p.workerPath) continue;
    try {
      const mod = (await import(pathToFileURL(p.workerPath).href)) as {
        default?: unknown;
        activate?: unknown;
      };
      const fn = mod.default ?? mod.activate;
      if (typeof fn !== 'function') throw new Error('worker facet 未导出默认函数');
      await (fn as (ctx: unknown) => unknown)({ bridge: bridgeFor(p.id) });
      logger.info({ pluginId: p.id }, 'worker facet loaded');
    } catch (err) {
      logger.error({ pluginId: p.id, err: String(err) }, 'worker facet failed to load (session continues)');
    }
  }

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

  /** 合并用的 message 计数器：只用于给 `message_update` 分组，不参与任何载荷。 */
  let messageCounter = 0;
  let currentMessageKey: string | null = null;

  // 合并 `message_update`：一条事件流同时喂 SSE 和 IM，在源头削薄对所有消费者都有利。
  // 除它以外的每一条事件都原样转发——包括我们不认识的类型，所以新增 pi 事件不需要
  // 改这里（投影侧决定哪些进客户端 UI）。
  const throttle = new DeltaThrottle((envelope) => emit(envelope));

  const unsubscribe = realSession.subscribe((event: unknown) => {
    const e = event as { type?: string };
    const type = e.type;
    if (!type) return;
    if (process.env.PROBE_EVENT_TYPES === '1') {
      logger.info({ type, keys: Object.keys(e) }, 'raw pi event');
    }

    if (type === 'message_start') {
      currentMessageKey = `msg-${++messageCounter}`;
    }

    if (type === 'message_update') {
      throttle.push(currentMessageKey ?? 'msg-0', { kind: 'event', event: type, data: e });
      return;
    }

    // 其余事件都是 flush 屏障：排队中的文本必须先落地，否则被边界事件挤掉尾巴。
    throttle.flush();
    if (type === 'message_end') {
      if (currentMessageKey) throttle.release(currentMessageKey);
      currentMessageKey = null;
    }
    emit({ event: type, data: e });
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