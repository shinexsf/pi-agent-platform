/**
 * HTTP API request/response DTOs.
 * Re-exports shared DTOs and adds HTTP-layer types.
 */

export type {
  AgentDTO,
  AgentTemplateDTO,
  AgentConfig,
  SessionDTO,
  SessionStatus,
  MessageDTO,
  MessageRole,
  ToolCallDTO,
  RuntimeConfig,
  ConfigIssue,
  SessionRunState,
} from '@pi-agent-platform/shared-types';

import type {
  AgentDTO,
  AgentTemplateDTO,
  AgentConfig,
  SessionDTO,
  MessageDTO,
  SessionRunState,
} from '@pi-agent-platform/shared-types';

import type {
  MenuRegistration,
  PageRegistration,
  PluginExtensions,
  PluginFacetName,
  PluginStatus,
  SurfaceRegistration,
  ToolCardRegistration,
} from '@pi-agent-platform/plugin-types';

export type { SurfaceRegistration } from '@pi-agent-platform/plugin-types';

// ---------- Agents ----------

export interface CreateAgentRequest {
  name: string;
  description?: string;
  workspacePath: string;
  model: string;
  thinkingLevel?: string;
  config?: AgentConfig;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  workspacePath?: string;
  model?: string;
  thinkingLevel?: string;
  config?: AgentConfig;
}

export type CreateAgentResponse = AgentDTO;
export type UpdateAgentResponse = AgentDTO;
export type GetAgentResponse = AgentDTO;
export type ListAgentsResponse = AgentDTO[];

// ---------- Sessions ----------

/** Response from POST /api/sessions/agents/:agentId (placeholder — spawns worker, no DB row yet) */
export interface PlaceholderSessionResponse {
  sessionId: string;
  agentId: string;
  /** 4-class slash commands (builtins + extensions + prompts + skills). Workers already spawn,
   *  so the IDE sees full command list immediately rather than waiting for the first message. */
  commands: SlashCommandDTO[];
  /** Globally available models from server's ModelRegistry. Independent of any worker. */
  models: ModelInfo[];
}

/** Wire-format slash command (same as worker's SlashCommandDTO). */
export interface SlashCommandDTO {
  name: string;
  description: string;
  argumentHint?: string;
  source: 'builtin' | 'extension' | 'prompt' | 'skill';
  sourceInfo?: unknown;
}

/** Wire-format model info (matches server ModelInfo). */
export interface ModelInfo {
  provider: string;
  modelId: string;
  displayName: string;
  hasAuth: boolean;
  /** Whether this model supports reasoning / thinking. */
  reasoning?: boolean;
  /** Maps thinking levels to provider-specific values. null = unsupported. */
  thinkingLevelMap?: Record<string, string | null>;
}

/** Unified session context returned by GET /api/sessions/:id/context.
 *  Combines slash commands + global models + session metadata into a single fetch. */
export interface SessionContextDTO {
  sessionId: string;
  /** Whether the session has been persisted to the DB (i.e. first prompt already sent). */
  hasRow: boolean;
  /** Session row from DB, or null if placeholder (no row yet). */
  session: SessionDTO | null;
  /** 4-class slash commands (builtins + extensions + prompts + skills). Empty array
   *  when worker is unavailable (placeholder timeout-evicted and not yet rebuilt). */
  commands: SlashCommandDTO[];
  /** Globally available models. Always populated (independent of worker). */
  models: ModelInfo[];
  /** The model the worker is currently using. Priority:
   *   1. workerPool entry's cached model (when worker alive — even for placeholder sessions)
   *   2. parse `session.model` (`provider/modelId`) when there's a DB row
   *   3. null when neither is available
   *  Always populated when a worker is alive; lets the IDE show the current model
   *  before the first message is sent. */
  currentModel: { provider: string; modelId: string } | null;
  /** The active thinking level. Same priority as currentModel:
   *   1. workerPool entry's cached thinkingLevel (when worker alive — placeholder included)
   *   2. session.thinkingLevel when there's a DB row
   *   3. null when neither is available.
   *  Thinking level is session-only (per OQ-D2) so active sessions don't persist it to DB,
   *  but workerPool entry is authoritative for the runtime value. */
  currentThinkingLevel: 'off' | 'low' | 'medium' | 'high' | null;
  /** Current context-window usage for the active model. Sourced from
   *  pi SDK `AgentSession.getContextUsage()`. Null when:
   *    - no worker is alive (placeholder, no rebuild)
   *    - model has no contextWindow field registered
   *  `tokens` / `percent` may be null independently when SDK can't estimate
   *  context size (e.g. right after a compaction, before the next LLM
   *  response — SDK reports null to signal "unknown until next turn"). */
  contextUsage: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
  /**
   * Runtime run state (change: session-streaming-runtime, design D3).
   *
   * Carried on the context payload so a freshly loaded chat page knows whether a
   * turn is already in flight (the phase-2 `session_snapshot` frame arrives only
   * after the stream connects). Optional for forward compatibility.
   */
  run?: SessionRunState;
}

/**
 * Runtime run state of a session (change: session-streaming-runtime).
 *
 * Defined in `@pi-agent-platform/shared-types` (single source of truth) and
 * re-exported above; this file only declares the DTO that embeds it.
 */

/** One server in the platform MCP catalog (`~/.pi/server/mcp.json`). */
export interface McpCatalogServerDTO {
  /** Server name — the key in `mcpServers`, also the tool namespace (`mcp__<name>__*`). */
  name: string;
  /** pi-shaped server config (command/args/env or url/headers), passed to `pi.registerMcpServer()`. */
  config: Record<string, unknown>;
  /** Effective exposure (`codemode` unless the entry says otherwise). */
  exposure: 'codemode' | 'deferred' | 'direct' | 'hidden';
  description?: string;
}

/**
 * Response of `GET /api/config/mcp-servers` (change: platform-mcp-catalog).
 *
 * `errors` carries per-entry problems so one broken server does not hide the rest.
 * `conflicts` names servers that pi's own `mcp.json` also defines — pi wins those, so
 * turning them off in the platform has no effect and the UI must say so.
 */
export interface McpCatalogResponseDTO {
  /** Absolute path of the catalog file that was read. */
  path: string;
  servers: McpCatalogServerDTO[];
  errors: string[];
  conflicts: string[];
}

/** Full session info returned by GET /api/sessions/:id/session-info. */
export interface SessionInfoDTO {
  sessionId: string;
  /** Whether the session has been persisted to the DB. */
  hasRow: boolean;
  /** Session row from DB, or null if placeholder. */
  session: SessionDTO | null;
  /** Full system prompt text sent to the LLM. */
  systemPrompt: { text: string; length: number; source: 'override' | 'default' } | null;
  /** Categorized resources available in this session. */
  resources: {
    prompts: Array<{ name: string; description: string; filePath: string }>;
    skills: Array<{ name: string; description: string; filePath: string; baseDir: string }>;
    extensions: Array<{ name: string; path: string; commandCount: number; toolCount: number }>;
    /**
     * Every non-MCP tool registered in the session (including tools the model can only reach
     * through `codemode`/`tool_search`, and `deferred` ones not loaded yet).
     *
     * MCP tools (`mcp__*` and the MCP resource tools) are NOT here — see `mcpServers`.
     *
     * `source` is the label shown on the badge:
     * - core tool / pi's own extension tools (`codemode`, `tool_search`) → `builtin`
     * - npm package / local extension file → its package/file label
     * - worker-registered tool (e.g. `sendFileToUser`) → `platform`
     */
    tools: Array<{
      name: string;
      description: string;
      source: string;
      sourceType: 'builtin' | 'extension' | 'sdk';
      /** How the model reaches the tool; `deferred` means registered but not loaded yet. */
      exposure: 'direct' | 'model-only' | 'codemode' | 'deferred' | 'hidden';
      /** Whether the tool is in the session's current active tool set. */
      active: boolean;
    }>;
    /**
     * MCP tools, grouped by server (change: mcp-as-first-class-capability).
     *
     * pi names MCP tools `mcp__<server>__<tool>` and exposes three extra resource tools without
     * that prefix; those go into a `kind: 'resources'` group that sorts last. A name that does not
     * match the pattern lands in `kind: 'server'` / `name: '(unknown)'` instead of being dropped.
     */
    mcpServers: Array<{
      /** Server name as it appears in the tool names (`-` already mapped to `_` by pi). */
      name: string;
      kind: 'server' | 'resources';
      tools: Array<{
        name: string;
        description: string;
        exposure: 'direct' | 'model-only' | 'codemode' | 'deferred' | 'hidden';
        active: boolean;
      }>;
    }>;
  };
  /** Worker PID (-1 if not running). */
  workerPid: number;
  /** Agent workspace path. */
  cwd: string;
  /** Worker uptime in ms (0 if not running). */
  uptimeMs: number;
  /** Current model. */
  currentModel: { provider: string; modelId: string } | null;
  /** Current thinking level. */
  currentThinkingLevel: 'off' | 'low' | 'medium' | 'high' | null;
  /** Context window usage. */
  contextUsage: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null;
}

export interface PromptRequest {
  message: string;
  images?: Array<{
    /** base64 data URL or absolute file path */
    source: string;
    mediaType: string;
  }>;
}

export interface PromptResponse {
  sessionId: string;
  workerPid: number;
}

export type ArchiveSessionResponse = SessionDTO;
export type GetSessionResponse = SessionDTO;
export type ListSessionsResponse = SessionDTO[];

/** Paged list of sessions. */
export interface PagedSessionsResponse {
  sessions: SessionDTO[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------- History ----------

export interface GetMessagesResponse {
  sessionId: string;
  messageCount: number;
  messages: MessageDTO[];
}

// ---------- Templates ----------

export interface CreateTemplateRequest {
  name: string;
  description?: string;
  config: AgentConfig;
}

export interface UpdateTemplateRequest {
  name?: string;
  description?: string;
  config?: AgentConfig;
}

export type ListTemplatesResponse = AgentTemplateDTO[];
export type TemplateResponse = AgentTemplateDTO;

// ---------- Plugins ----------

/** 插件在会话/列表中的只读视图。 */
/** 某个 facet 入口文件的探测结果。 */
export interface FacetEntryPointDTO {
  path: string;
  exists: boolean;
  candidates: string[];
}

export interface PluginEntryDTO {
  /** 插件 id = npm 包名。 */
  id: string;
  version: string;
  status: PluginStatus;
  /** 人类可读的降级/停用原因。 */
  reason?: string;
  /** 面向人的说明（`package.json` 的 `description`）。 */
  description?: string;
  author?: string;
  homepage?: string;
  /** 开关 ∧ 声明 ∧ 入口（可加载）；保留旧语义。 */
  facets: Partial<Record<PluginFacetName, boolean>>;
  /** 磁盘上声明了哪些 facet（只看目录存在）。 */
  declaredFacets: PluginFacetName[];
  /** registry 里显式关闭的 facet（原样）。 */
  switches: Partial<Record<PluginFacetName, boolean>>;
  /** 平台实际会装载的 facet（不含 `server`：本期仅声明）。 */
  loadedFacets: PluginFacetName[];
  /** 各 facet 的入口探测结果（列表页用它区分"声明了但没编译"）。 */
  entries: Record<PluginFacetName, FacetEntryPointDTO>;
  /** 依赖的 pi 插件（包名 → semver range）。 */
  requires: Record<string, string>;
  /** 安装目录绝对路径。 */
  dir: string;
  /** 安装时间（ISO）。 */
  installedAt?: string;
}

/** facet 在当前平台的装载支持度。 */
export type FacetSupport = 'loaded' | 'declared-only';

export interface ListPluginsResponse {
  plugins: PluginEntryDTO[];
  /** 全局 kill switch 是否生效。 */
  disabledByFlag: boolean;
  /** 插件根目录（页面上要显示"装到哪了"）。 */
  pluginsDir: string;
  /** 各 facet 的装载支持情况（`server` 本期为 `declared-only`）。 */
  facetSupport: Record<PluginFacetName, FacetSupport>;
}

/** 依赖的 pi 插件的安装状态。 */
export interface PluginDependencyDTO {
  name: string;
  range: string;
  /** `null` = 无法判定（例如 pi 的 settings.json 不可读）。 */
  installed: boolean | null;
  via?: 'settings' | 'node_modules';
  version?: string;
}

export interface PluginDetailDTO {
  plugin: PluginEntryDTO;
  /** 四个 facet 的入口探测结果；不做该 facet 时为 `null`。 */
  entryPoints: Record<PluginFacetName, FacetEntryPointDTO>;
  dependencies: PluginDependencyDTO[];
  /** `<dir>/package.json` */
  manifestPath: string;
  registryEntry: {
    id: string;
    version: string;
    dir: string;
    enabled: boolean;
    facets?: Partial<Record<PluginFacetName, boolean>>;
    installedAt?: string;
  };
}

export interface GetPluginDetailResponse {
  detail: PluginDetailDTO;
}

// ---------- 运行期扩展点（注册式） ----------

/** 带来源插件的注册项。 */
export type WithPlugin<T> = T & { pluginId: string };

/** `GET /api/extensions`：全局注册（导航用）。 */
export interface GlobalExtensionsResponse {
  menus: WithPlugin<MenuRegistration>[];
  pages: WithPlugin<PageRegistration>[];
  disabledByFlag: boolean;
}

/** `GET /api/plugins/:id/extensions`：单插件全集（含被拒项）。 */
export interface PluginExtensionsResponse {
  pluginId: string;
  extensions: PluginExtensions;
}

/** `GET /api/sessions/:id/extensions`：会话级（经闸门过滤）。 */
export interface SessionExtensionsResponse {
  surfaces: WithPlugin<SurfaceRegistration>[];
  toolCards: WithPlugin<ToolCardRegistration>[];
  /** 被闸门拦下的插件及原因（插件 id → 原因）。 */
  disabled: Record<string, string>;
  disabledByFlag: boolean;
  /** 占位会话（库里还没有行）：此时不做闸门过滤。 */
  placeholder?: boolean;
}

// ---------- Error ----------

export interface ApiError {
  error: string;
  path?: string;
}