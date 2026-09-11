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

  // Builtin tools whitelist (null = all, [] = none, ['read','write'] = only these)
  builtinTools?: string[];

  // Extension whitelist (names from settings.json packages + extensions)
  extensions?: string[];

  // Skills whitelist (null = all, [] = none, ['a','b'] = only these)
  skills?: string[];

  // Prompts whitelist (null = all, [] = none, ['a','b'] = only these)
  prompts?: string[];

  // MCP servers (future)
  mcpServers?: Record<string, unknown>;
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
}