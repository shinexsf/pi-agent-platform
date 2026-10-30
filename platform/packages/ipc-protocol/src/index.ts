/**
 * IPC protocol between master (Hono) and worker (pi SDK).
 *
 * Wire format (JSON over child_process IPC channel):
 *
 * Master → Worker: CallRequest
 * Worker → Master: CallResponse | WorkerEvent | ReverseCallRequest
 * Master → Worker: ReverseCallResponse
 *
 * Method names correspond directly to pi SDK AgentSession methods
 * (see packages/sdk-integration/AgentSessionProxy).
 */

/** Methods callable on the worker */
export type WorkerMethod =
  | 'createSession'
  | 'prompt'
  | 'abort'
  | 'setModel'
  | 'setThinkingLevel'
  | 'setTools'
  | 'listCommands'
  | 'dispatchCommand'
  | 'listAvailableModels'
  | 'compact'
  | 'getContextUsage'
  | 'getSystemPrompt'
  | 'getSessionResources'
  | 'setSessionName'
  | 'pluginEmit';

export interface CallRequest {
  kind: 'call';
  id: number;
  method: WorkerMethod;
  args: unknown[];
}

export interface CallResponseOk {
  kind: 'response';
  id: number;
  ok: true;
  result: unknown;
}

export interface CallResponseErr {
  kind: 'response';
  id: number;
  ok: false;
  error: {
    message: string;
    stack?: string;
  };
}

export type CallResponse = CallResponseOk | CallResponseErr;

export type WorkerEventKind =
  | 'ready'
  | 'message_update'
  | 'message_end'
  | 'tool_call'
  | 'tool_result'
  | 'agent_end'
  /** A run started (pi-native `agent_start`). data: `{ startedAt: number }`. */
  | 'agent_start'
  /** A run settled (pi-native `agent_settled`). data: `{ aborted: boolean }`. */
  | 'agent_settled'
  | 'queue_update'
  | 'error'
  /** pi-native session display name changed (data: { name }) — master-internal,
   *  consumed to sync sessions.title; NOT forwarded to SSE clients. */
  | 'session_info_changed'
  /** 插件事件（change: plugin-mechanism）。data 为 `PluginEventPayload`，
   *  master 转发为 SSE 事件名 `plugin.<pluginId>.<name>`。 */
  | 'plugin_event';

/**
 * 插件事件的载荷。由 worker/extension facet 的 `bridge.emit(name, data)` 发出。
 * 与消息事件共用同一条流，顺序天然一致。
 */
export interface PluginEventPayload {
  pluginId: string;
  name: string;
  data: unknown;
}

/**
 * 会话创建时下发的插件集合（已按会话闸门解析）。
 * `enabled: false` 时 worker 只记录 `reason`，不执行任何 import。
 *
 * 形状与 `@pi-agent-platform/plugin-types` 的 `ResolvedPlugin` 对齐；
 * 这里保留独立定义，避免 ipc-protocol 增加运行时依赖。
 */
export interface WorkerPluginSpec {
  id: string;
  dir: string;
  enabled: boolean;
  reason?: string;
  extensionPath?: string;
  workerPath?: string;
}

export interface WorkerEvent {
  kind: 'event';
  event: WorkerEventKind;
  data?: unknown;
}

export type WorkerMessage = CallResponse | WorkerEvent | ReverseCallResponse;

// ── Reverse IPC: Worker → Master ──────────────────────────────────────────

/** Methods callable on the master from worker (reverse direction) */
export type ReverseMethod =
  | 'sendFileToUser'
  /** Server-management capability dispatch. args contract: `[method: string, params?: object]`.
   *  Registered once by the master-side control plane (capabilities/index.ts) at startup;
   *  all callServer methods flow through this single reverse method. */
  | 'invokeCapability';

/** Worker → Master: reverse RPC call request */
export interface ReverseCallRequest {
  kind: 'reverse-call';
  id: number;
  method: ReverseMethod;
  args: unknown[];
}

/** Master → Worker: reverse RPC call response */
export interface ReverseCallResponse {
  kind: 'reverse-response';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { message: string; stack?: string };
}

/** createSession returns this — piSessionPath is stored in master DB */
export interface CreateSessionResult {
  /** Opaque handle, used as the "this" for subsequent calls */
  sessionHandle: string;
  /** Absolute path to session history file (jsonl) — stored in DB */
  piSessionPath: string;
  /** Actual model the worker resolved (pi SDK AgentSession.model) — cached on master WorkerEntry
   *  so /:id/context can return currentModel without an extra IPC round-trip. */
  model?: { provider: string; modelId: string } | null;
  /** Active thinking level (pi SDK AgentSession.thinkingLevel) — same caching rationale. */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | null;
  /** pi-native session display name at creation time (sessionManager.getSessionName()).
   *  Master compares it against sessions.title on load (heal, DB wins). */
  sessionName?: string;
}