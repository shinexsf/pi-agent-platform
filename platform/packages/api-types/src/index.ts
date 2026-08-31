/**
 * HTTP API request/response DTOs.
 * Re-exports shared DTOs and adds HTTP-layer types.
 */

export type {
  AgentDTO,
  SessionDTO,
  SessionStatus,
  MessageDTO,
  MessageRole,
  ToolCallDTO,
  RuntimeConfig,
} from '@pi-agent-platform/shared-types';

import type { AgentDTO, SessionDTO, MessageDTO } from '@pi-agent-platform/shared-types';

// ---------- Agents ----------

export interface CreateAgentRequest {
  name: string;
  description?: string;
  workspacePath: string;
  model: string;
  thinkingLevel?: string;
  systemPrompt: string;
  appendSystemPrompt?: string;
  tools: string[];
  config?: Record<string, unknown>;
}

export interface UpdateAgentRequest {
  name?: string;
  description?: string;
  workspacePath?: string;
  model?: string;
  thinkingLevel?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  tools?: string[];
  config?: Record<string, unknown>;
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

// ---------- Error ----------

export interface ApiError {
  error: string;
  path?: string;
}