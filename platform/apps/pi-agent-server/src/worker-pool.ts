/**
 * WorkerPool — manages child processes that run pi agent sessions.
 *
 * Lifecycle (per session):
 * 1. spawn(sessionId) → child process (running tsx for .ts support) + 200ms ready detection
 * 2. send(call) → returns Promise resolved by CallResponse
 * 3. worker emits WorkerEvent → forwarded to subscribers (SSE)
 * 4. kill(sessionId) → SIGTERM → 5s → SIGKILL
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
import { fileURLToPath } from 'node:url';
import type {
  CallRequest,
  CallResponse,
  WorkerEvent,
  WorkerEventKind,
} from '@pi-agent-platform/ipc-protocol';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Prefer the compiled dist (no loader needed); fall back to .ts source under tsx.
// Note: under tsx, import.meta.url may point to a temp location; use process.cwd() + relative path as fallback.
import { existsSync } from 'node:fs';

function resolveWorkerEntry(): string {
  const candidates = [
    path.resolve(process.cwd(), '../../workers/session-worker/dist/index.js'),
    path.resolve(process.cwd(), '../../workers/session-worker/src/index.ts'),
    path.resolve(__dirname, '../../workers/session-worker/dist/index.js'),
    path.resolve(__dirname, '../workers/session-worker/dist/index.js'),
    path.resolve(process.cwd(), 'workers/session-worker/dist/index.js'),
    path.resolve(process.cwd(), '../workers/session-worker/dist/index.js'),
    path.resolve(__dirname, '../../workers/session-worker/src/index.ts'),
    path.resolve(process.cwd(), 'workers/session-worker/src/index.ts'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error('Worker entry not found. Tried: ' + candidates.join(', '));
}

const WORKER_ENTRY = resolveWorkerEntry();

/** Detect if master runs under tsx (so we should propagate the loader to children). */
const RUNS_UNDER_TSX =
  process.env.NODE_OPTIONS?.includes('--import') ||
  process.env.NODE_OPTIONS?.includes('--loader') ||
  process.execArgv.some((a) => a.includes('tsx'));

export interface WorkerEntry {
  sessionId: string;
  child: ChildProcess;
  workerPid: number;
  stderrTail: string[];
  ready: boolean;
  spawnTime: number;
  readyTimer: NodeJS.Timeout | null;
  pendingCalls: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  eventListeners: Array<(event: WorkerEvent) => void>;
  /** True once the session has been persisted to the DB (first prompt written the row).
   *  Active sessions are not auto-killed; placeholder workers (`hasRow=false`) participate in
   *  the 5-minute placeholder timeout and LRU eviction. */
  hasRow: boolean;
  /** Path to the pi session file (set after createSession IPC returns). Available for both
   *  placeholder and active workers — needed so the first prompt on a placeholder worker can
   *  persist the row without re-creating the underlying session. */
  piSessionPath?: string;
  /** Cached system prompt (set after createSession IPC returns). Avoids re-fetching the
   *  full system prompt string over IPC for every `GET /:id/context` call. */
  systemPrompt?: { text: string; length: number; source: 'override' | 'default' };
  /** Actual model the worker is using (from pi SDK AgentSession.model).
   *  Set by spawnPlaceholder / spawnAndCreate / POST /:id/model route.
   *  Drives /:id/context's `currentModel` field for placeholder sessions
   *  that don't yet have a DB row. */
  model?: { provider: string; modelId: string } | null;
  /** Active thinking level on the worker (pi SDK AgentSession.thinkingLevel).
   *  Set by spawnPlaceholder / spawnAndCreate / POST /:id/think route.
   *  Drives /:id/context's `currentThinkingLevel` field for placeholder sessions
   *  that don't yet have a DB row. */
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | null;
}

type PendingListener = { listener: (event: WorkerEvent) => void; attached: boolean };

export class WorkerPool extends EventEmitter {
  private workers = new Map<string, WorkerEntry>();
  /** Max concurrent workers. Spawn will LRU-evict a placeholder worker when full. */
  private maxWorkers: number;
  /** Listeners that subscribed before the worker existed; flushed on spawn ready. */
  private pendingListeners = new Map<string, PendingListener[]>();
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

    const nodeArgs = WORKER_ENTRY.endsWith('.ts') && RUNS_UNDER_TSX ? ['--import', 'tsx/esm', WORKER_ENTRY] : [WORKER_ENTRY];
    const child = spawn(process.execPath, nodeArgs, {
      // stdin: ignore, stdout: inherit (visible in master log), stderr: pipe (captured), ipc: required
      stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
      // Worker process cwd = agent workspace (so plugins using process.cwd() resolve correctly).
      cwd: workspacePath ?? process.cwd(),
      env: { ...process.env, PI_AGENT_DIR: config.agentDir, PI_AGENT_ATTACHMENTS_ROOT: config.attachmentsDir },
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
      eventListeners: [],
      hasRow: false,
    };

    this.wireUpHandlers(sessionId, entry);
    this.workers.set(sessionId, entry);

    return new Promise((resolve, reject) => {
      const checkReady = () => {
        if (entry.ready) {
          // Worker ready — flush any listeners that subscribed before spawn.
          this.flushPendingListeners(sessionId, entry);
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

    // Stderr capture (last 100 chunks FIFO)
    if (entry.child.stderr) {
      entry.child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        entry.stderrTail.push(text);
        if (entry.stderrTail.length > 100) {
          entry.stderrTail.shift();
        }
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
        for (const listener of entry.eventListeners) {
          listener(event);
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
      }
    });

    // Crash detection
    entry.child.on('exit', (code, signal) => {
      const w = this.workers.get(sessionId);
      this.workers.delete(sessionId);
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
   * Subscribe to WorkerEvent for a session.
   * If no worker exists yet, buffer the listener and attach when spawn completes.
   * Returns an unsubscribe function.
   */
  subscribe(sessionId: string, listener: (event: WorkerEvent) => void): () => void {
    const entry = this.workers.get(sessionId);
    if (entry) {
      entry.eventListeners.push(listener);
      return () => {
        const idx = entry.eventListeners.indexOf(listener);
        if (idx >= 0) entry.eventListeners.splice(idx, 1);
      };
    }
    // No worker yet — buffer at class level so spawn() can flush on ready.
    let arr = this.pendingListeners.get(sessionId);
    if (!arr) {
      arr = [];
      this.pendingListeners.set(sessionId, arr);
    }
    const pending: PendingListener = { listener, attached: false };
    arr.push(pending);

    // Try attaching on growing delays (covers fast spawn before setTimeout resolves).
    const tryAttach = () => {
      if (pending.attached) return;
      const e = this.workers.get(sessionId);
      if (e) {
        e.eventListeners.push(pending.listener);
        pending.attached = true;
      }
    };
    setTimeout(tryAttach, 10);
    setTimeout(tryAttach, 100);
    setTimeout(tryAttach, 500);
    setTimeout(tryAttach, 2000);
    setTimeout(tryAttach, 6000);
    setTimeout(tryAttach, 12000);

    return () => {
      pending.attached = true; // prevent future attaches
      const e = this.workers.get(sessionId);
      if (e) {
        const i = e.eventListeners.indexOf(pending.listener);
        if (i >= 0) e.eventListeners.splice(i, 1);
      }
      const a = this.pendingListeners.get(sessionId);
      if (a) {
        const idx = a.indexOf(pending);
        if (idx >= 0) a.splice(idx, 1);
      }
    };
  }

  /**
   * Move all pending listeners for this session onto the entry's eventListeners.
   * Called when worker becomes ready so SSE clients don't miss events that fire
   * between worker spawn and the next setTimeout retry.
   */
  private flushPendingListeners(sessionId: string, entry: WorkerEntry): void {
    const arr = this.pendingListeners.get(sessionId);
    if (!arr || arr.length === 0) return;
    for (const pending of arr) {
      if (!pending.attached) {
        entry.eventListeners.push(pending.listener);
        pending.attached = true;
      }
    }
    this.pendingListeners.delete(sessionId);
  }

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
      hasRow: w.hasRow,
    }));
  }

  /**
   * Mark the worker's session as having a persisted DB row. Called from
   * `spawnAndCreate` after the row is created/updated. After this, the worker
   * is excluded from LRU eviction and the placeholder timeout scanner.
   */
  markRowWritten(sessionId: string): void {
    const entry = this.workers.get(sessionId);
    if (entry) entry.hasRow = true;
  }

  /** Record the pi session file path returned by worker's createSession IPC.
   *  Called by spawnPlaceholder (placeholder worker) and spawnAndCreate (active worker)
   *  so subsequent spawnAndCreate calls on a still-alive worker can reuse it
   *  without re-creating the underlying session. */
  setSessionPath(sessionId: string, piSessionPath: string): void {
    const entry = this.workers.get(sessionId);
    if (entry) entry.piSessionPath = piSessionPath;
  }

  /** Cache the worker's actual model so /:id/context can report currentModel
   *  without an extra IPC round-trip. Called from spawnPlaceholder / spawnAndCreate
   *  (after createSession) and from POST /:id/model route (after worker.setModel). */
  setModel(sessionId: string, model: { provider: string; modelId: string } | null): void {
    const entry = this.workers.get(sessionId);
    if (entry) entry.model = model;
  }

  /** Cache the worker's active thinking level so /:id/context can report
   *  currentThinkingLevel without an extra IPC round-trip. */
  setThinkingLevel(sessionId: string, level: 'off' | 'low' | 'medium' | 'high' | null): void {
    const entry = this.workers.get(sessionId);
    if (entry) entry.thinkingLevel = level;
  }

  /** Cache the worker's system prompt (text + length + source) so /:id/context
   *  can report the full systemPrompt without re-fetching ~10K+ chars per call. */
  setSystemPrompt(
    sessionId: string,
    systemPrompt: { text: string; length: number; source: 'override' | 'default' },
  ): void {
    const entry = this.workers.get(sessionId);
    if (entry) entry.systemPrompt = systemPrompt;
  }

  /** Find the oldest placeholder worker (`hasRow=false`) and kill it. Returns the killed sessionId, or null if none available. */
  private async evictOldestPlaceholder(): Promise<string | null> {
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, e] of this.workers) {
      if (!e.hasRow && e.spawnTime < oldestTime) {
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