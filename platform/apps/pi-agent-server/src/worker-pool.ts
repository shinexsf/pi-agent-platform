/**
 * WorkerPool — manages child processes that run pi agent sessions.
 *
 * Lifecycle (per session):
 * 1. spawn(sessionId) → child process (running tsx for .ts support) + 200ms ready detection
 * 2. send(call) → returns Promise resolved by CallResponse
 * 3. worker emits WorkerEvent → pool EMITS `session_event` (sessionId, event);
 *    SessionRegistry (services/session.ts) fans out to per-session subscribers
 * 4. kill(sessionId) → SIGTERM → 5s → SIGKILL
 *
 * Process domain ONLY (core-session-refactor 2.3): domain state (hasRow /
 * model / …) lives on Session; the pool asks via the injected hasRowQuery
 * for LRU eviction / list() semantics.
 *
 * Invariants enforced:
 * - 200ms startup detection (kill if no 'ready' event)
 * - SIGTERM graceful stop (5s timeout, then SIGKILL)
 * - stderr last-100-chunks collection (FIFO)
 * - worker crash → sessions.status = 'archived'
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import type {
  CallRequest,
  CallResponse,
  ReverseCallRequest,
  WorkerEvent,
  WorkerEventKind,
} from '@pi-agent-platform/ipc-protocol';
import { config } from './config.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Prefer the compiled dist (no loader needed); fall back to .ts source under tsx.
// Note: under tsx, import.meta.url may point to a temp location; use process.cwd() + relative path as fallback.
import { existsSync } from 'node:fs';

function resolveWorkerEntry(): string {
  // Packaged mode (started by `pi-server` CLI): use absolute path injected via env.
  // The CLI sets PI_SERVER_CLI=1 + WORKER_DIST_DIR=<global>/dist/worker at spawn time.
  if (process.env.PI_SERVER_CLI && process.env.WORKER_DIST_DIR) {
    return path.join(process.env.WORKER_DIST_DIR, 'index.js');
  }
  // Dev mode: prefer .ts source (no build needed); fall back to compiled dist.
  const candidates = [
    path.resolve(process.cwd(), '../../workers/session-worker/src/index.ts'),
    path.resolve(process.cwd(), '../../workers/session-worker/dist/index.js'),
    path.resolve(__dirname, '../../workers/session-worker/src/index.ts'),
    path.resolve(__dirname, '../workers/session-worker/src/index.ts'),
    path.resolve(process.cwd(), 'workers/session-worker/src/index.ts'),
    path.resolve(process.cwd(), '../workers/session-worker/src/index.ts'),
    path.resolve(__dirname, '../../workers/session-worker/dist/index.js'),
    path.resolve(process.cwd(), 'workers/session-worker/dist/index.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error('Worker entry not found. Tried: ' + candidates.join(', '));
}

const WORKER_ENTRY = resolveWorkerEntry();

/**
 * Absolute URL of the tsx ESM loader, resolved from the MASTER's module graph.
 * Passed to workers as `--import <url>`: workers spawn with the agent workspace
 * as cwd, so the bare specifier 'tsx/esm' would resolve against the workspace
 * (which usually has no tsx) and crash with ERR_MODULE_NOT_FOUND.
 */
const TSX_LOADER_URL: string | null = (() => {
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href;
  } catch {
    return null;
  }
})();

export interface WorkerEntry {
  sessionId: string;
  child: ChildProcess;
  workerPid: number;
  stderrTail: string[];
  ready: boolean;
  spawnTime: number;
  readyTimer: NodeJS.Timeout | null;
  pendingCalls: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  // Phase B (core-session-refactor 2.3): domain state (hasRow / model /
  // thinkingLevel / sessionName / systemPrompt / piSessionPath / agentId)
  // moved to Session (services/session.ts). WorkerEntry keeps PROCESS facts only.
}

export type ReverseCallHandler = (sessionId: string, args: unknown[]) => Promise<unknown>;

export class WorkerPool extends EventEmitter {
  private workers = new Map<string, WorkerEntry>();
  /** Max concurrent workers. Spawn will LRU-evict a placeholder worker when full. */
  private maxWorkers: number;
  /** Handlers for reverse-call messages from workers (worker → master RPC). */
  private reverseHandlers = new Map<string, ReverseCallHandler>();
  /** Is this session a placeholder (no DB row)? Domain knowledge injected at
   *  composition time (initSessionRegistry) — pool must not import Session. */
  private hasRowQuery: (sessionId: string) => boolean = () => false;
  private nextCallId = 1;

  constructor(maxWorkers: number = config.maxWorkers) {
    super();
    this.maxWorkers = maxWorkers;
  }

  /**
   * Spawn a worker for a session. Resolves once 'ready' event arrives
   * (within 200ms — otherwise rejects and kills the child).
   *
   * `workspacePath` (optional) sets the worker process's cwd, so third-party
   * pi plugins that read process.cwd() see the agent's workspace, not the
   * master's startup dir. Falls back to process.cwd() if not provided.
   *
   * If the pool is at capacity, evicts the oldest placeholder worker
   * (`hasRow=false`, smallest `spawnTime`). Throws if all workers are active.
   */
  async spawn(sessionId: string, workspacePath?: string): Promise<WorkerEntry> {
    if (this.workers.has(sessionId)) {
      throw new Error(`worker already exists for session ${sessionId}`);
    }

    if (this.workers.size >= this.maxWorkers) {
      const evicted = await this.evictOldestPlaceholder();
      if (!evicted) {
        throw new Error('No placeholder worker available to evict; all sessions active');
      }
    }

    if (WORKER_ENTRY.endsWith('.ts') && !TSX_LOADER_URL) {
      throw new Error(`worker entry ${WORKER_ENTRY} is TypeScript but the tsx loader could not be resolved from the server`);
    }
    const nodeArgs = WORKER_ENTRY.endsWith('.ts') ? ['--import', TSX_LOADER_URL as string, WORKER_ENTRY] : [WORKER_ENTRY];
    const child = spawn(process.execPath, nodeArgs, {
      // stdin: ignore, stdout: inherit (visible in master log), stderr: pipe (captured), ipc: required
      stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
      // Worker process cwd = agent workspace (so plugins using process.cwd() resolve correctly).
      cwd: workspacePath ?? process.cwd(),
      env: { ...process.env, PI_AGENT_DIR: config.agentDir, PI_AGENT_ATTACHMENTS_ROOT: config.attachmentsDir },
      // On Windows, spawning a child from a detached/GUI process would otherwise
      // pop up a new console window for the worker. Hide it; logs still go to
      // server.log via the inherited stdout / captured stderr pipe.
      windowsHide: true,
    });

    const entry: WorkerEntry = {
      sessionId,
      child,
      workerPid: child.pid ?? -1,
      stderrTail: [],
      ready: false,
      spawnTime: Date.now(),
      readyTimer: null,
      pendingCalls: new Map(),
    };

    this.wireUpHandlers(sessionId, entry);
    this.workers.set(sessionId, entry);

    return new Promise((resolve, reject) => {
      const checkReady = () => {
        if (entry.ready) {
          resolve(entry);
        } else if (!this.workers.has(sessionId)) {
          reject(new Error(`worker startup failed for session ${sessionId}`));
        } else {
          setTimeout(checkReady, 10);
        }
      };
      checkReady();
    });
  }

  private wireUpHandlers(sessionId: string, entry: WorkerEntry): void {
    // 200ms ready detection — invariants
    entry.readyTimer = setTimeout(() => {
      if (!entry.ready) {
        this.kill(sessionId, 'startup-timeout');
      }
    }, config.workerStartupTimeoutMs);

    // Stderr capture (last 100 chunks FIFO) + re-log onto the shared timeline.
    // Worker logs are pino JSON lines on stderr (session-worker/src/logger.ts);
    // non-JSON lines (stack traces, third-party SDK output) are logged raw.
    let lineBuf = '';
    const emitLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const base = { sessionId, workerPid: entry.child.pid };
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && typeof parsed.level === 'number') {
          const lv = parsed.level as number;
          const { level: _lv, time: _time, msg, ...fields } = parsed;
          const text = typeof msg === 'string' ? msg : trimmed;
          const merged = { ...fields, ...base };
          if (lv >= 50) logger.error(merged, text);
          else if (lv >= 40) logger.warn(merged, text);
          else if (lv <= 20) logger.debug(merged, text);
          else logger.info(merged, text);
          return;
        }
      } catch {
        /* not JSON — fall through */
      }
      logger.info({ ...base, raw: trimmed }, 'worker stderr');
    };
    if (entry.child.stderr) {
      entry.child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        entry.stderrTail.push(text);
        if (entry.stderrTail.length > 100) {
          entry.stderrTail.shift();
        }
        lineBuf += text;
        let idx = lineBuf.indexOf('\n');
        while (idx >= 0) {
          emitLine(lineBuf.slice(0, idx).replace(/\r$/, ''));
          lineBuf = lineBuf.slice(idx + 1);
          idx = lineBuf.indexOf('\n');
        }
      });
      entry.child.stderr.on('end', () => {
        if (lineBuf.trim()) emitLine(lineBuf);
        lineBuf = '';
      });
    }

    // IPC message handling
    entry.child.on('message', (msg: unknown) => {
      if (!msg || typeof msg !== 'object') return;
      const m = msg as { kind?: unknown };

      if (m.kind === 'event') {
        const event = msg as WorkerEvent;
        if (event.event === ('ready' as WorkerEventKind)) {
          if (entry.readyTimer) {
            clearTimeout(entry.readyTimer);
            entry.readyTimer = null;
          }
          entry.ready = true;
        }
        // Phase B: pool only FORWARDS — Session (services/session.ts) owns
        // per-session listener sets and subscribes to this emitter once.
        this.emit('session_event', sessionId, event);
        // Master-internal consumption: pi-native renames (any source) sync into
        // sessions.title — wired in index.ts; the pool itself never touches the DB.
        if (event.event === 'session_info_changed') {
          this.emit('session_info_changed', sessionId, (event.data as { name?: string } | undefined)?.name);
        }
        return;
      }

      if (m.kind === 'response') {
        const res = msg as CallResponse;
        const pending = entry.pendingCalls.get(res.id);
        if (!pending) return;
        entry.pendingCalls.delete(res.id);
        if (res.ok) {
          pending.resolve(res.result);
        } else {
          pending.reject(new Error(res.error.message));
        }
        return;
      }

      if (m.kind === 'reverse-call') {
        const req = msg as ReverseCallRequest;
        void this.handleReverseCall(sessionId, entry, req);
        return;
      }
    });

    // Crash detection
    entry.child.on('exit', (code, signal) => {
      this.workers.delete(sessionId);

      // Phase B (core-session-refactor 2.4/2.5): listener buffering/transfer
      // across worker death moved to Session — the registry disposes the Session
      // object on this 'crash' event (notified + cleared); clients reconnect
      // (EventSource auto-reconnect) and re-subscribe to the next object.

      if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGKILL') {
        process.stderr.write(
          `[server] worker exited unexpectedly, sessionId=${sessionId} pid=${entry.workerPid} code=${code} signal=${signal}\n`,
        );
      }
      for (const p of entry.pendingCalls.values()) {
        p.reject(new Error(`worker exited (code=${code} signal=${signal})`));
      }
      entry.pendingCalls.clear();
      this.emit('crash', sessionId, code, signal);
    });
  }

  async call<T = unknown>(sessionId: string, method: string, args: unknown[]): Promise<T> {
    const entry = this.workers.get(sessionId);
    if (!entry) throw new Error(`no worker for session ${sessionId}`);
    if (!entry.ready) throw new Error(`worker not ready for session ${sessionId}`);

    const id = this.nextCallId++;
    const req: CallRequest = { kind: 'call', id, method: method as never, args };
    return new Promise<T>((resolve, reject) => {
      entry.pendingCalls.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      entry.child.send(req, (err) => {
        if (err) {
          entry.pendingCalls.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Phase B (core-session-refactor 2.4): per-session event subscription moved
   * to Session (services/session.ts). Pool only EMITS `session_event`
   * (sessionId, event) — Session attaches one filtered listener at a time.
   */

  async kill(sessionId: string, reason = 'manual'): Promise<void> {
    const entry = this.workers.get(sessionId);
    if (!entry) return;

    if (entry.readyTimer) {
      clearTimeout(entry.readyTimer);
      entry.readyTimer = null;
    }

    return new Promise<void>((resolve) => {
      const child = entry.child;
      const forceTimer = setTimeout(() => {
        process.stderr.write(`[server] worker kill force SIGKILL, sessionId=${sessionId}\n`);
        child.kill('SIGKILL');
      }, config.workerStopTimeoutMs);

      child.once('exit', () => {
        clearTimeout(forceTimer);
        resolve();
      });

      try {
        child.kill('SIGTERM');
        process.stderr.write(
          `[server] worker kill SIGTERM, sessionId=${sessionId} reason=${reason}\n`,
        );
      } catch {
        clearTimeout(forceTimer);
        resolve();
      }
    });
  }

  get(sessionId: string): WorkerEntry | undefined {
    return this.workers.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.workers.has(sessionId);
  }

  /** Snapshot of one session's runtime worker state for HTTP responses. */
  toSummary(
    sessionId: string,
  ): import('@pi-agent-platform/shared-types').WorkerSummary | null {
    const entry = this.workers.get(sessionId);
    if (!entry) return null;
    return {
      pid: entry.workerPid,
      ready: entry.ready,
      uptimeMs: Date.now() - entry.spawnTime,
      pendingCalls: entry.pendingCalls.size,
    };
  }

  list(): Array<{
    sessionId: string;
    workerPid: number;
    ready: boolean;
    uptimeMs: number;
    stderrTail: string[];
    pendingCalls: number;
    spawnTime: number;
    hasRow: boolean;
  }> {
    return Array.from(this.workers.values()).map((w) => ({
      sessionId: w.sessionId,
      workerPid: w.workerPid,
      ready: w.ready,
      uptimeMs: Date.now() - w.spawnTime,
      stderrTail: [...w.stderrTail],
      pendingCalls: w.pendingCalls.size,
      spawnTime: w.spawnTime,
      hasRow: this.hasRowQuery(w.sessionId),
    }));
  }

  /**
   * Inject the domain question "does this session have a DB row?" (placeholder
   * vs active). Wired by initSessionRegistry — worker-pool stays domain-free
   * (process facts only) while LRU eviction / list() keep their semantics.
   */
  setHasRowQuery(fn: (sessionId: string) => boolean): void {
    this.hasRowQuery = fn;
  }

  // ── Reverse IPC: Worker → Master ────────────────────────────────────────

  /** Register a handler for a reverse-call method from workers. */
  registerReverseCallHandler(method: string, handler: ReverseCallHandler): void {
    this.reverseHandlers.set(method, handler);
  }

  /** Handle a reverse-call request from a worker. Dispatches to registered handler and replies. */
  private async handleReverseCall(
    sessionId: string,
    entry: WorkerEntry,
    req: ReverseCallRequest,
  ): Promise<void> {
    const handler = this.reverseHandlers.get(req.method);
    if (!handler) {
      entry.child.send({
        kind: 'reverse-response',
        id: req.id,
        ok: false,
        error: { message: `Unknown reverse method: ${req.method}` },
      });
      return;
    }
    try {
      const result = await handler(sessionId, req.args);
      entry.child.send({ kind: 'reverse-response', id: req.id, ok: true, result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      process.stderr.write(`[server] reverse-call error method=${req.method} sessionId=${sessionId}: ${msg}\n`);
      if (stack) process.stderr.write(`${stack}\n`);
      entry.child.send({
        kind: 'reverse-response',
        id: req.id,
        ok: false,
        error: { message: msg, stack },
      });
    }
  }

  /** Find the oldest placeholder worker (no DB row, per hasRowQuery) and kill it. Returns the killed sessionId, or null if none available. */
  private async evictOldestPlaceholder(): Promise<string | null> {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, e] of this.workers) {
      if (!this.hasRowQuery(id) && e.spawnTime < oldestTime) {
        oldestTime = e.spawnTime;
        oldestId = id;
      }
    }
    if (oldestId === null) return null;
    await this.kill(oldestId, 'lru-eviction');
    process.stderr.write(`[server] LRU-evicted placeholder worker ${oldestId}\n`);
    return oldestId;
  }

  async shutdown(): Promise<void> {
    const ids = Array.from(this.workers.keys());
    await Promise.all(ids.map((id) => this.kill(id, 'shutdown')));
  }
}

export const workerPool = new WorkerPool();