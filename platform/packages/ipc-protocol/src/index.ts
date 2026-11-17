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

// ── Envelopes (both directions, one shape) ────────────────────────────────
//
// A call and a reverse-call are the same thing seen from two ends: someone asks,
// someone answers. Keeping them as one family means the pending/response plumbing
// on both sides cannot drift (design D1) — the only difference is `kind`.

/** Shared request envelope. `kind` is the only field that differs by direction. */
export interface CallEnvelope<K extends 'call' | 'reverse-call'> {
  kind: K;
  id: number;
  method: string;
  args: unknown[];
}

/** Shared success envelope. */
export interface ResponseOkEnvelope<K extends 'response' | 'reverse-response'> {
  kind: K;
  id: number;
  ok: true;
  result: unknown;
}

/** Shared failure envelope. */
export interface ResponseErrEnvelope<K extends 'response' | 'reverse-response'> {
  kind: K;
  id: number;
  ok: false;
  error: {
    message: string;
    stack?: string;
  };
}

/** Shared response envelope (discriminated by `ok`, not by optional fields). */
export type ResponseEnvelope<K extends 'response' | 'reverse-response'> =
  | ResponseOkEnvelope<K>
  | ResponseErrEnvelope<K>;

/** Methods callable on the worker. Mirror entries match pi `AgentSession` 1:1. */
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
  | 'setSessionName';
// NOTE: there is deliberately no `pluginEmit` method. A plugin's downlink is its OWN
// registered method (`plugin.<pluginId>.emit`), so "who can receive this" is answered
// by the registry instead of by a special-cased platform method.

export interface CallRequest extends CallEnvelope<'call'> {
  method: WorkerMethod;
}

export type CallResponseOk = ResponseOkEnvelope<'response'>;
export type CallResponseErr = ResponseErrEnvelope<'response'>;
export type CallResponse = ResponseEnvelope<'response'>;

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
  /** pi-native `auto_retry_start`: a provider call failed and pi scheduled a retry.
   *  Master forwards it to SSE; clients render "retrying N/M" progress.
   *  data: `RunRetryStartDTO`-shaped `{ attempt, maxAttempts, delayMs, errorMessage }`. */
  | 'auto_retry_start'
  /** pi-native `auto_retry_end`: retry budget finished (success or exhausted).
   *  data: `RunRetryEndDTO`-shaped `{ success, attempt, finalError? }`. */
  | 'auto_retry_end'
  | 'queue_update'
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

// ── Method registry ──────────────────────────────────────────────────────

/** Which way a method travels. `forward` = master→worker, `reverse` = worker→master. */
export type IpcDirection = 'forward' | 'reverse';

/** Which side owns the handler for a method (derived from direction, kept as data so
 *  diagnostics can list "where does this method run" without knowing our conventions). */
export type IpcHandlerSide = 'worker' | 'master';

/** Who provides the method. Built-ins are `core`; plugins are `plugin:<pluginId>`. */
export type IpcMethodSource = 'core' | `plugin:${string}`;

/** `mirror` = 1:1 pi `AgentSession` method; `platform` = platform lifecycle method;
 *  `plugin` = contributed by a plugin. */
export type IpcMethodKind = 'mirror' | 'platform' | 'plugin';

export type IpcMethodStatus = 'enabled' | 'disabled' | 'deprecated';

/** One registry row. `handler` is deliberately NOT part of it — entries are plain
 *  data, which is what makes them shippable in the `ready` handshake. */
export interface IpcMethodEntry {
  name: string;
  direction: IpcDirection;
  handlerSide: IpcHandlerSide;
  source: IpcMethodSource;
  kind: IpcMethodKind;
  status: IpcMethodStatus;
  description?: string;
  /** Diagnostics only for now — never validated at dispatch. */
  paramsSchema?: unknown;
}

/** Serializable registry row exchanged between master and worker. */
export type IpcMethodSummary = IpcMethodEntry;

/** A handler bound to the registry. `ctx` is opaque to the registry — master's reverse
 *  table passes the calling `sessionId`, the worker's forward table passes nothing. */
export type IpcHandler = (args: unknown[], ctx?: unknown) => unknown;

export interface IpcRegisterOptions {
  direction: IpcDirection;
  source: IpcMethodSource;
  kind: IpcMethodKind;
  /** Optional: MUST agree with the direction-derived value when supplied. */
  handlerSide?: IpcHandlerSide;
  status?: IpcMethodStatus;
  description?: string;
  paramsSchema?: unknown;
}

/** A registration that was refused. Surfaced for diagnostics — a rejected plugin
 *  method is a visible event, never a silent no-op. */
export interface IpcRejectedEntry {
  name: string;
  source: IpcMethodSource;
  reason: string;
}

/** `resolve()` result. Errors are pre-worded so both sides report identically. */
export type IpcResolveResult =
  | { ok: true; entry: IpcMethodEntry; handler: IpcHandler }
  | { ok: false; error: string };

/** The `plugin.<pluginId>.` prefix every plugin-contributed method must carry. */
export function pluginMethodPrefix(pluginId: string): string {
  return `plugin.${pluginId}.`;
}

/**
 * IPC method registry — the single dispatch authority for one direction side.
 *
 * Master keeps the reverse table (who calls me), worker keeps the forward table.
 * Instances are per-process; nothing is shared across the IPC boundary except
 * `summary()` output.
 *
 * Registration is where structural governance happens (design D3): plugin methods
 * must carry `plugin.<theirOwnId>.`, so "a plugin impersonating `prompt`" is
 * impossible at registration time rather than caught by review.
 */
export class IpcMethodRegistry {
  private readonly entries = new Map<string, IpcMethodEntry>();
  private readonly handlers = new Map<string, IpcHandler>();
  private readonly rejectedEntries: IpcRejectedEntry[] = [];

  /** Register one method. Returns the entry, or `undefined` when rejected. */
  register(name: string, opts: IpcRegisterOptions, handler: IpcHandler): IpcMethodEntry | undefined {
    const expectedSide: IpcHandlerSide = opts.direction === 'forward' ? 'worker' : 'master';
    if (opts.handlerSide && opts.handlerSide !== expectedSide) {
      return this.reject(name, opts.source, `handlerSide '${opts.handlerSide}' conflicts with direction '${opts.direction}'`);
    }
    const prefixError = this.checkPrefix(name, opts.source);
    if (prefixError) return this.reject(name, opts.source, prefixError);
    if (this.entries.has(name)) {
      const prev = this.entries.get(name)!;
      return this.reject(name, opts.source, `name already registered by '${prev.source}'`);
    }
    const entry: IpcMethodEntry = {
      name,
      direction: opts.direction,
      handlerSide: expectedSide,
      source: opts.source,
      kind: opts.kind,
      status: opts.status ?? 'enabled',
      ...(opts.description ? { description: opts.description } : {}),
      ...(opts.paramsSchema !== undefined ? { paramsSchema: opts.paramsSchema } : {}),
    };
    this.entries.set(name, entry);
    this.handlers.set(name, handler);
    return entry;
  }

  /**
   * Register a whole group under one source (service-level registration, design D4).
   * A single bad name must not sink the others — each rejection is recorded.
   */
  registerMany(
    source: IpcMethodSource,
    group: { direction: IpcDirection; kind: IpcMethodKind; descriptions?: Record<string, string> },
    handlers: Record<string, IpcHandler>,
  ): IpcMethodEntry[] {
    const out: IpcMethodEntry[] = [];
    for (const [name, handler] of Object.entries(handlers)) {
      const entry = this.register(
        name,
        { direction: group.direction, kind: group.kind, source, description: group.descriptions?.[name] },
        handler,
      );
      if (entry) out.push(entry);
    }
    return out;
  }

  /**
   * Look up a method. Returns a pre-worded error for the two failure modes so
   * callers can surface it verbatim (design D8).
   */
  resolve(name: string): IpcResolveResult {
    const entry = this.entries.get(name);
    if (!entry) return { ok: false, error: `unknown method: ${name}` };
    if (entry.status === 'disabled') return { ok: false, error: `method disabled: ${name}` };
    const handler = this.handlers.get(name);
    if (!handler) return { ok: false, error: `unknown method: ${name}` };
    return { ok: true, entry, handler };
  }

  /** Plain-data snapshot for the `ready` handshake and diagnostics. */
  summary(): IpcMethodSummary[] {
    return [...this.entries.values()]
      .map((e) => ({ ...e }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Disable every method a plugin contributed. Entries are kept (not deleted) so
   *  callers can tell "disabled" apart from "never existed". */
  disableByPlugin(pluginId: string): number {
    return this.setStatusByPlugin(pluginId, 'disabled');
  }

  /** Re-enable a plugin's methods after re-enabling the plugin (no server restart). */
  enableByPlugin(pluginId: string): number {
    return this.setStatusByPlugin(pluginId, 'enabled');
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  list(): IpcMethodEntry[] {
    return [...this.entries.values()];
  }

  /** Registrations that were refused — diagnostics, and the feed for `rejected[]`. */
  rejected(): IpcRejectedEntry[] {
    return [...this.rejectedEntries];
  }

  private setStatusByPlugin(pluginId: string, status: IpcMethodStatus): number {
    const source: IpcMethodSource = `plugin:${pluginId}`;
    let n = 0;
    for (const [name, entry] of this.entries) {
      if (entry.source !== source) continue;
      this.entries.set(name, { ...entry, status });
      n++;
    }
    return n;
  }

  /** Built-ins MUST stay unprefixed; plugin methods MUST carry their own id. */
  private checkPrefix(name: string, source: IpcMethodSource): string | undefined {
    if (source === 'core') {
      return name.startsWith('plugin.') ? `core method '${name}' must not use the 'plugin.' namespace` : undefined;
    }
    const pluginId = source.slice('plugin:'.length);
    return name.startsWith(pluginMethodPrefix(pluginId))
      ? undefined
      : `plugin method '${name}' must start with '${pluginMethodPrefix(pluginId)}'`;
  }

  private reject(name: string, source: IpcMethodSource, reason: string): undefined {
    this.rejectedEntries.push({ name, source, reason });
    return undefined;
  }
}

// ── Reverse IPC: Worker → Master ──────────────────────────────────────────

/** Worker → Master: reverse RPC call request — same envelope as `CallRequest`.
 *  `method` is a plain string: the master-side registry is the authority; there is no
 *  fixed method union to keep in sync (design D2/D3). */
export type ReverseCallRequest = CallEnvelope<'reverse-call'>;

/** Master → Worker: reverse RPC call response — same envelope as `CallResponse`. */
export type ReverseCallResponse = ResponseEnvelope<'reverse-response'>;

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