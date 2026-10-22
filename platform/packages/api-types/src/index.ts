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
} from '@pi-agent-platform/shared-types';

import type { AgentDTO, AgentTemplateDTO, AgentConfig, SessionDTO, MessageDTO } from '@pi-agent-platform/shared-types';

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
}

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

// ---------- Error ----------

export interface ApiError {
  error: string;
  path?: string;
}