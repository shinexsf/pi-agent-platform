/**
 * HTTP API request/response DTOs.
 * Re-exports shared DTOs and adds HTTP-layer types.
 */

export type {
  AgentDTO,
  NotificationDTO,
  NotificationSeverity,
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
  NotificationDTO,
} from '@pi-agent-platform/shared-types';

import type {
  HeaderActionDefinition,
  MenuRegistration,
  PageRegistration,
  PluginExtensions,
  PluginFacetName,
  PluginStatus,
  SurfaceRegistration,
  ToolCardRegistration,
} from '@pi-agent-platform/plugin-types';
export type { HeaderActionDefinition } from '@pi-agent-platform/plugin-types';

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
  /** 来源：`bundled` 随包分发（目录即在），`user` 用户登记。 */
  source: 'bundled' | 'user';
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
    dir: string;
    enabled: boolean;
    /** `bundled` 的插件不在 registry 里（目录存在即生效）。 */
    source: 'bundled' | 'user';
    inRegistry: boolean;
  };
}

export interface GetPluginDetailResponse {
  detail: PluginDetailDTO;
}

// ---------- 运行期扩展点（注册式） ----------

/** 带来源插件的注册项。 */
export type WithPlugin<T> = T & { pluginId: string };

/** `GET /api/extensions`：全局注册（导航用）。 */
/** 插件页面 + 导航展示字段（服务端已把菜单摊进来，前端不再 join 两遍）。 */
export interface RegistryPageDTO extends PageRegistration {
  pluginId: string;
  label?: string;
  icon?: string;
  order?: number;
  /** 父页面路径（`/im`）或旧的静态父模块名（`config`）。 */
  parent?: string;
}

/**
 * 槽位注册项（带来源插件与服务端生成的装载地址）。
 *
 * `url` 由服务端给出：`/plugins/<pluginId>/web/<component>.js[?v=<rev>]`。
 * 消费方（宿主插件的 web facet）MUST 直接 `import(url)`，不要自己拼路径 ——
 * 否则 URL 规则会在平台与每个宿主插件里各存一份。
 */
export interface RegistrySurfaceDTO {
  pluginId: string;
  slot: string;
  id: string;
  title?: string;
  icon?: string;
  order?: number;
  /** `web/<component>.js` 的文件名（不含扩展名）。 */
  component: string;
  /** 服务端生成的装载地址。 */
  url: string;
}

/** 顶栏动作（R11，带来源插件）。 */
export interface RegistryHeaderActionDTO extends HeaderActionDefinition {
  pluginId: string;
}

export interface GlobalExtensionsResponse {
  /** 合一列表：`pages` 已带导航字段（有 `label` 才进导航）。 */
  pages: RegistryPageDTO[];
  /** 顶栏图标按钮区（平铺 / 移动端收起由前端决定）。 */
  headerActions: RegistryHeaderActionDTO[];
  /**
   * 插件空间槽位（`<pluginId>.<name>`）：由**宿主插件自己**装载（平台不渲染）。
   * 例：IM 页消费 `im.channel.create` 来渲染各渠道的新增连接弹窗。
   */
  surfaces: RegistrySurfaceDTO[];
  /**
   * 旧字段，保留一个版本。前端不再读它；第三方若读过，等移除时一起清。
   */
  menus: WithPlugin<MenuRegistration>[];
  disabledByFlag: boolean;
  /**
   * 插件 web 资源版本（插件 id → 版本串）。前端拼成 `.../<entry>.js?v=<rev>`，
   * 让改完代码后能拿到新模块（浏览器按 URL 缓存 ES module，HTTP 缓存头不够用）。
   */
  revs?: Record<string, string>;
}

/** `GET /api/plugins/:id/extensions`：单插件全集（含被拒项）。 */
export interface PluginExtensionsResponse {
  pluginId: string;
  extensions: PluginExtensions;
  /** 该插件声明的 topic 与提供的 service（运行期，随装载变化）。 */
  interop?: PluginInteropDTO;
  /** 该插件声明的动作（一份 handler 的多个暴露面）。 */
  actions?: PluginActionDTO[];
}

/** 一个插件的互操作声明（目录用）。 */
export interface PluginInteropDTO {
  topics: Array<{
    topic: string;
    owner: string;
    declaredBy: 'publisher' | 'subscriber';
    subscribers: number;
    pending: number;
    lastPublishAt: string | null;
  }>;
  services: Array<{ name: string; owner: string }>;
}

/** `GET /api/runtime/interop`：全部 topic 与服务目录（诊断 / 排查"我发了没人收"）。 */
export interface PluginInteropResponse extends PluginInteropDTO {}

/** 一条动作的暴露面（`GET /api/runtime/actions`）。 */
export interface PluginActionDTO {
  /** 全名 `<pluginId>.<action>`。 */
  name: string;
  owner: string;
  /** `own` = 只有自己插件的 worker 能调；`public` = 任何插件都能调。 */
  scope: 'own' | 'public';
  /** 是否注册了反向方法。 */
  reverse: boolean;
  /** 是否作为 service 提供给别的插件。 */
  service: boolean;
  /** 是否暴露成 pi 工具（模型可见，取决于 `tool_search` / exposure）。 */
  hasTool: boolean;
  /** 工具名（暴露为工具时才有，否则 null）。 */
  toolName: string | null;
  /** HTTP 子路径（相对 `/api/p/<owner>`），未暴露为 null。 */
  http: string | null;
  /** 是否带 JSON Schema（tool / http 面必然有）。 */
  hasParams: boolean;
}

/** `GET /api/runtime/actions`：动作目录（一份 handler 的多面暴露并排可见）。 */
export interface PluginActionsResponse {
  actions: PluginActionDTO[];
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
  /** 同 `GlobalExtensionsResponse.revs`。 */
  revs?: Record<string, string>;
}

// ---------- Error ----------

export interface ApiError {
  error: string;
  path?: string;
}

export interface NotificationListResponse {
  items: NotificationDTO[];
  unreadCount: number;
}

// ---------- Session tree（change: session-tree-and-fork）----------

/**
 * 会话树的一个节点 —— pi 的 JSONL entry 裁剪后的客户端形状。
 *
 * `id` / `parentId` MUST 原样保留（前端要用它做"当前分支"判定与定位）；
 * 其余字段是为了渲染：`preview` 是文本前若干字符，`label` 来自 pi 的 label entry。
 */
export interface SessionTreeNodeDTO {
  id: string;
  parentId: string | null;
  /** pi entry 类型：`message` / `custom_message` / `compaction` / `model_change` / … */
  type: string;
  /** `type==='message'` 时的 role。 */
  role?: 'user' | 'assistant' | 'toolResult' | string;
  /** 一行预览（消息取正文前 N 字，其它类型给个简短描述）。 */
  preview: string;
  /** pi 的 label（书签），没有则缺省。 */
  label?: string;
  timestamp?: string;
  /** 子节点数量（前端决定是否画展开箭头）。 */
  childCount: number;
  /** 是否当前分支末端。 */
  isLeaf: boolean;
  children: SessionTreeNodeDTO[];
}

/** `GET /api/sessions/:id/tree`。 */
export interface SessionTreeResponse {
  sessionId: string;
  /** 当前分支末端（空会话为 null）。 */
  leafId: string | null;
  tree: SessionTreeNodeDTO[];
}

/** `POST /api/sessions/:id/tree/navigate` 请求体。 */
export interface SessionNavigateRequest {
  /** 目标 entry id。 */
  entryId: string;
  /** 乐观并发校验：与当前 leaf 不一致时 409（防止多窗口"最后导航赢"静默错位）。 */
  expectedLeafId?: string;
}

/** `POST /api/sessions/:id/tree/navigate` 响应。 */
export interface SessionNavigateResponse {
  ok: true;
  leafId: string | null;
  /** 目标 entry 是 user/custom message 时的文本（"放回输入框"语义）。 */
  editorText?: string;
}
