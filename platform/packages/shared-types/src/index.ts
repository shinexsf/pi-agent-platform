/**
 * Shared DTO types used by server, web, and worker.
 *
 * Conventions:
 * - Path fields are stored normalized (forward slash + lowercase Windows drive)
 * - Time fields are epoch milliseconds (number)
 * - JSON fields (tools, config) are typed loosely as `unknown[]` / `Record<string, unknown>`
 *   to keep this package zero-dependency; concrete types live in api-types
 */

// ---------- Agent Config ----------
/** Agent configuration - stored as JSON in agents/sessions config column. */
export interface AgentConfig {
  // System prompt
  systemPrompt?: string;
  appendSystemPrompt?: string;

  // Tool enable list — explicit allowlist that drives BOTH activation and built-in
  // extension loading (change: explicit-agent-config):
  // - plain pi builtin tools: read / write / edit / bash / grep / find / ls / powershell
  // - pi builtin EXTENSION tools: codemode / tool_search (naming one loads `builtin:<ext>`
  //   in the worker)
  // Semantics: this is the ONLY source of truth. missing/null = empty (no tools).
  // The platform has no "inherit global default" layer. MCP is NOT a tool and MUST NOT
  // appear here — see `mcp` below.
  builtinTools?: string[];

  // Extension whitelist (names from settings.json packages + extensions).
  // missing/null = empty (no extensions).
  extensions?: string[];

  // Skills whitelist. missing/null = empty (no skills).
  skills?: string[];

  // Prompts whitelist. missing/null = empty (no prompts).
  prompts?: string[];

  // MCP capability switch (change: mcp-as-first-class-capability).
  // Owns the built-in `mcp` extension: loading it connects every server in `mcp.json` on
  // session start. Enabling it also loads+activates codemode & tool_search, because a server's
  // default `exposure: "codemode"` leaves its tools unreachable otherwise.
  // missing/null = off ({"enabled": false}). Object (not a bare boolean) so per-agent server
  // lists / default exposure can be added later.
  mcp?: { enabled?: boolean };

  // Per-server MCP overrides (future MCP management). Not read by the worker yet — the
  // servers actually connected come from pi's own mcp.json (global + project).
  mcpServers?: Record<string, unknown>;

  // Server-side tool whitelist (sendFileToUser / callServer — the custom tools
  // that talk to the master via reverse IPC). Semantics: missing/null = empty (none).
  // Independent from `builtinTools` (which governs pi builtin tools + builtin extension tools).
  serverBuiltinTools?: string[];

  // callServer method-level allowlist. null/undefined = use the global default
  // policy (control-plane default: reads on, writes off); [] = deny all business
  // methods (list/detail stay available); array = explicit allowlist.
  // Enforced by the master-side control plane at dispatch time — the tool
  // switch (serverBuiltinTools) only controls prompt-layer injection.
  capabilities?: string[] | null;
}

/**
 * Resolved form of {@link AgentConfig}: every resource field is present.
 *
 * Only the 7 resource fields are normalized — prompt / model / thinkingLevel stay
 * optional on purpose (the UI writes them as part of ResourceConfig but the
 * boundary contract only guarantees the resource lists).
 */
export interface ResolvedAgentConfig extends AgentConfig {
  extensions: string[];
  skills: string[];
  prompts: string[];
  builtinTools: string[];
  mcp: { enabled: boolean };
  serverBuiltinTools: string[];
  capabilities: string[] | null;
}

/**
 * Normalize a stored config into {@link ResolvedAgentConfig}: missing/null resource
 * fields become empty; `mcp` becomes `{ enabled: false }`; `capabilities` keeps its
 * tri-state meaning (null = global default policy).
 *
 * Invariant: `capabilities` is the method-level authorization for `callServer`, so when
 * `callServer` is not in `serverBuiltinTools` the authorization is meaningless and is
 * forced to `[]` (全禁). Without this, a template/agent saved after unchecking
 * `callServer` would keep stale authorizations that silently reactivate when the tool
 * is switched back on.
 *
 * This is the single place where "missing means empty" is applied (change:
 * explicit-agent-config). There is deliberately no global-default merge layer.
 */
export function normalizeAgentConfig(config?: AgentConfig | null): ResolvedAgentConfig {
  const c = config ?? {};
  const serverBuiltinTools = c.serverBuiltinTools ?? [];
  return {
    ...c,
    extensions: c.extensions ?? [],
    skills: c.skills ?? [],
    prompts: c.prompts ?? [],
    builtinTools: c.builtinTools ?? [],
    mcp: { enabled: c.mcp?.enabled === true },
    serverBuiltinTools,
    capabilities: serverBuiltinTools.includes('callServer') ? (c.capabilities ?? null) : [],
  };
}

/**
 * Pi builtin tools + the two builtin-extension tools that appear in the tool checklist.
 * `mcp` is deliberately absent (it is a capability switch, see {@link AgentConfig.mcp}).
 */
export const PLATFORM_BUILTIN_TOOLS = [
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'find',
  'ls',
  'powershell',
  'codemode',
  'tool_search',
] as const;

/** Worker-registered platform tools (`AgentConfig.serverBuiltinTools`). */
export const PLATFORM_SERVER_TOOLS = ['sendFileToUser', 'callServer'] as const;

/** A stored config value that no longer resolves (renamed tool, uninstalled extension, …). */
export interface ConfigIssue {
  /** Which config field the value came from. */
  field: 'extensions' | 'skills' | 'prompts' | 'builtinTools' | 'serverBuiltinTools' | 'capabilities' | 'model';
  /** The offending value. */
  value: string;
  /** Human-readable reason (Chinese, shown directly in the web UI). */
  reason: string;
}

/** What currently exists — supplied by the caller (server route or web composable). */
export interface ConfigAvailability {
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  capabilities?: string[];
  /** `provider/model` strings. */
  models?: string[];
  tools?: string[];
  serverTools?: string[];
}

/**
 * Pure rule table shared by server (save response) and web (live highlighting).
 *
 * A field is only checked when the caller supplies its availability list — omitted lists
 * produce no issues (no false positives from partial knowledge).
 */
export function findConfigIssues(
  config: AgentConfig | null | undefined,
  available: ConfigAvailability = {},
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const check = (
    field: ConfigIssue['field'],
    values: readonly string[] | undefined,
    known: readonly string[] | undefined,
    reason: string,
  ) => {
    if (!known || !values) return;
    const set = new Set(known);
    for (const value of values) {
      if (!set.has(value)) issues.push({ field, value, reason });
    }
  };

  check('extensions', config?.extensions, available.extensions, '插件不存在或未安装');
  check('skills', config?.skills, available.skills, 'Skill 不存在');
  check('prompts', config?.prompts, available.prompts, 'Prompt 模板不存在');
  check(
    'builtinTools',
    config?.builtinTools,
    available.tools ?? [...PLATFORM_BUILTIN_TOOLS],
    '工具不存在',
  );
  check(
    'serverBuiltinTools',
    config?.serverBuiltinTools,
    available.serverTools ?? [...PLATFORM_SERVER_TOOLS],
    '平台工具不存在',
  );
  check('capabilities', config?.capabilities ?? undefined, available.capabilities, '授权方法不存在');
  return issues;
}

// ---------- Agent ----------
export interface AgentDTO {
  id: string;
  name: string;
  description?: string;
  workspacePath: string; // normalized: forward slash + lowercase Windows drive

  model: string;
  thinkingLevel?: string;
  config?: AgentConfig; // parsed from JSON column

  createdAt: number; // epoch ms
  updatedAt: number;
}

/**
 * Saved configuration template: a snapshot of the seven AgentConfig fields
 * (`systemPrompt` + resources + `capabilities`), no agent name/description.
 * Applying a template overwrites those fields and clears `systemPrompt`
 * (it is not part of a template).
 *
 * `config` is normalized with `normalizeAgentConfig()` on write — a template
 * means exactly what it says, there is no inheritance layer.
 */
export interface AgentTemplateDTO {
  id: string;
  name: string;
  description?: string;
  config: AgentConfig;
  createdAt: number;
  updatedAt: number;
}

// ---------- Session ----------
export type SessionStatus = 'active' | 'archived';

export interface WorkerSummary {
  pid: number;
  ready: boolean;
  uptimeMs: number;
  pendingCalls: number;
}

export interface SessionDTO {
  id: string;
  agentId: string;

  model: string;
  thinkingLevel?: string;
  config?: AgentConfig; // parsed from JSON column

  piSessionPath: string; // normalized absolute path to jsonl history file

  status: SessionStatus;
  title?: string;

  createdAt: number;
  lastActiveAt: number;

  /** Runtime worker state (null when no worker is currently running for this session). */
  worker: WorkerSummary | null;
  /** Runtime model provider (e.g. "anthropic"). Together with `model`, fully identifies the runtime model. */
  currentProvider?: string;
}

// ---------- Message ----------
/** Matches pi SDK AgentMessage roles (user / assistant / toolResult) + 'error' for inline error items. */
export type MessageRole = 'user' | 'assistant' | 'toolResult' | 'error';

export interface ToolCallDTO {
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Tool execution result, flattened to string (text blocks joined). */
  result?: string;
  isError?: boolean;
  /** Image blocks attached to a toolResult message (e.g. read-tool returned an image).
   *  Carried onto the assistant's toolCall via `mergeToolResultsIntoCalls` in useSSE.
   *  Distinct from user-pasted images (which live on the assistant's sibling user message),
   *  but same render path in `<ImageGrid>`. */
  images?: Array<{ mimeType: string; data: string; sha256?: string }>;
}

export interface MessageDTO {
  id: string;
  /** Tree pointer (pi SDK stores messages as a parentId-linked tree). */
  parentId?: string;
  role: MessageRole;
  /** Flattened text content (text blocks joined). */
  content: string;
  /** Thinking content (for assistant with reasoning). */
  thinking?: string;
  /** Tool calls the assistant requested (assistant only). */
  toolCalls?: ToolCallDTO[];
  /** For toolResult messages: which tool call this result belongs to. */
  toolCallId?: string;
  /** Assistant-only: which model generated this. */
  model?: string;
  provider?: string;
  /** Assistant-only: why the turn ended. */
  stopReason?: string;
  /** ToolResult-only: the tool's display name. */
  toolName?: string;
  /** ToolResult-only: whether the tool execution failed.
   *  Mirrors pi SDK `ToolResultMessage.isError` (a top-level field on the
   *  message — NOT inside content blocks, NOT inside `stopReason` which is
   *  assistant-only). Without this, IDE history replay can't distinguish
   *  completed from failed tool calls. */
  isError?: boolean;
  /** Image blocks (user-pasted AND read-tool — both ride into history view).
   *  Server-side: read from `JSONL` `content[]` during history load (`GET /:id/messages`).
   *  Client-side: filled from `useAttachments.cache` for current-session live rendering.
   *  Same shape for both paths — single render path in `<MessageItem>` / `<ImageGrid>`. */
  images?: Array<{ mimeType: string; data: string; sha256?: string }>;
  timestamp: number; // epoch ms
}

/** Lightweight DTO sent over SSE for incremental updates.
 *  Workers emit one of these per pi SDK event; web consumes via SSE. */
export interface MessageDeltaDTO {
  /** Same id as the message being updated; first emission uses message_start id. */
  messageId: string;
  parentId?: string;
  role: MessageRole;
  /** Accumulated content (worker maintains the running total). */
  content?: string;
  thinking?: string;
  toolCalls?: ToolCallDTO[];
  toolCallId?: string;
  toolName?: string;
  model?: string;
  provider?: string;
  stopReason?: string;
  /** ToolResult-only: mirrors pi SDK `ToolResultMessage.isError`.
   *  Set on the delta emitted alongside a toolResult message's
   *  `message_start`/`message_end` so streaming clients can mark the matching
   *  toolCall as failed without subscribing to the separate `tool_result`
   *  SSE event. Undefined for non-toolResult messages. */
  isError?: boolean;
}

// ---------- RuntimeConfig (used by worker to create pi AgentSession) ----------
export interface RuntimeConfig {
  model: string;
  thinkingLevel?: string;
  workspacePath: string;
  config?: AgentConfig; // All agent config (systemPrompt, tools, extensions, etc.)
  /** Control-plane capability index (compact), pushed by master at createSession so
   *  the callServer tool description can embed it (zero-round-trip first use).
   *  Plain data — no handlers; the single source of truth stays on master. */
  capabilityIndex?: CapabilityIndexEntry[];
}

// ---------- Server capability control plane (callServer) ----------

/** Functional module a capability belongs to (list/detail grouping dimension). */
export type CapabilityModule = 'server' | 'agent' | 'session' | 'channel' | 'config';

/** Authorization class (orthogonal to module): read vs write, gated by the
 *  global read/write × all/own policy in the control plane. */
export type CapabilityAccess = 'read' | 'write';

/** Compact per-capability entry pushed to workers (RuntimeConfig.capabilityIndex). */
export interface CapabilityIndexEntry {
  method: string;       // e.g. 'session.update'
  module: CapabilityModule;
  access: CapabilityAccess;
  scoped: boolean;       // own-mode restricts to caller's own agent/session rows
  summary: string;      // one-liner shown in the tool description
}

/** Who is invoking a capability — resolved by the control plane from the
 *  reverse-call's sessionId (trust boundary: master, never the worker). */
export interface InvokeContext {
  sessionId: string;
  /** Agent the calling session belongs to (from sessions row); undefined for
   *  placeholder sessions (no row yet) — own-mode checks must handle this. */
  agentId?: string;
}

/** Full capability definition — registered master-side only (handler never
 *  crosses IPC). `list`/`detail` are built-in and exempt from allowlist checks. */
export interface CapabilityDef<Params = unknown, Result = unknown> {
  method: string;                       // unique, dotted: '<module>.<action>'
  module: CapabilityModule;
  access: CapabilityAccess;
  /** true = own-mode restricts to the caller's own agent/session rows. */
  scoped: boolean;
  summary: string;                      // one-liner for list/description
  paramsSchema: Record<string, unknown>; // JSON Schema (for detail)
  returns: string;                      // incl. effect-timing notes (for detail)
  handler: (ctx: InvokeContext, params: Params) => Promise<Result> | Result;
}

/** Storage/return type for heterogeneous capability collections (handler param
 *  is contravariant — specific Params defs won't assign to CapabilityDef<unknown>). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCapabilityDef = CapabilityDef<any, any>;