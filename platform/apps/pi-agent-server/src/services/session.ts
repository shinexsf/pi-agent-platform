/**
 * services/session — shared spawn helpers used by both routes/sessions.ts (web/IDE)
 * and im-gateway/routing.ts (IM channels).
 *
 * Extracted from routes/sessions.ts (then im-gateway/session-bridge) and moved
 * core-ward: IM gateway re-uses the exact same session lifecycle (placeholder →
 * first prompt → active) without going through HTTP, but the CORE owns it — this
 * file must not live under im-gateway/ (core must never import im-gateway).
 *
 * Phase A of core-session-refactor: file relocated + SessionRegistry facade
 * (getOrCreate / createFromAgent / dispose / list) — spawnPlaceholder /
 * spawnAndCreate are now MODULE-PRIVATE; all consumers must go through the
 * registry (sole entry). Phase B: domain state (hasRow / model /
 * thinkingLevel / sessionName / systemPrompt / piSessionPath / agentId)
 * migrated OFF WorkerEntry ONTO Session; event subscription + dispose live
 * here too; worker-pool only forwards (`session_event` emitter) and asks the
 * registry via injected hasRowQuery (LRU / list() semantics preserved).
 */

import type { RuntimeConfig, AgentConfig } from '@pi-agent-platform/shared-types';
import type { WorkerEvent } from '@pi-agent-platform/ipc-protocol';
import type { WorkerPool } from '../worker-pool.js';
import type { AgentRepo } from '../repos/agent.repo.js';
import type { SessionRepo } from '../repos/session.repo.js';
import { readSettings, type GlobalSettings } from './settings-reader.js';
import { buildCapabilityIndex, resolveEffectiveCapabilities } from '../capabilities/registry.js';
import { renameSession as renameSessionOp } from './session-ops.js';
import { childLogger } from '../logger.js';

const logger = childLogger('session');

interface AgentLike {
  id: string;
  workspacePath: string;
  model: string;
  thinkingLevel?: string;
  config?: AgentConfig;
}

interface CreateSessionResult {
  sessionHandle?: string;
  piSessionPath: string;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | null;
  /** pi-native session display name (session-title-sync heal input). */
  sessionName?: string;
}

/** Phase 1: spawn placeholder worker + createSession (no DB row yet). */
async function spawnPlaceholder(
  session: Session,
  agent: AgentLike,
  workerPool: WorkerPool,
): Promise<void> {
  const sessionId = session.id;
  await workerPool.spawn(sessionId, agent.workspacePath);
  session.agentId = agent.id;
  const runtimeConfig = buildRuntimeConfig(agent);
  const result = await workerPool.call<CreateSessionResult>(
    sessionId,
    'createSession',
    [runtimeConfig, sessionId, undefined],
  );
  session.piSessionPath = result.piSessionPath;
  session.model = result.model ?? null;
  session.thinkingLevel = result.thinkingLevel ?? null;
  session.sessionName = result.sessionName;
  // Cache the system prompt for /:id/context (avoid IPC round-trip on every
  // context fetch; the prompt can be 10K+ chars).
  await cacheSystemPrompt(session, workerPool);
}

/**
 * Phase 2: persist session row + ensure worker is alive.
 *
 * - If worker alive (placeholder): reuse, just persist row + update model.
 * - If worker dead: spawn fresh, pass `existingSessionPath` so pi re-loads history.
 */
async function spawnAndCreate(
  session: Session,
  agent: AgentLike,
  sessionRepo: SessionRepo,
  workerPool: WorkerPool,
  existingSessionPath?: string,
): Promise<{ piSessionPath: string } | undefined> {
  const sessionId = session.id;
  let piSessionPath: string;
  let piSessionName: string | undefined;
  let actualModelOverride: string | undefined;
  let actualThinkingLevelOverride: 'off' | 'low' | 'medium' | 'high' | undefined;

  if (workerPool.has(sessionId)) {
    // Worker alive (placeholder reused) — the SESSION object carries the
    // spawn-time domain state (written by spawnPlaceholder on THIS object).
    if (!session.piSessionPath) {
      throw new Error(`placeholder worker ${sessionId} has no cached piSessionPath`);
    }
    piSessionPath = session.piSessionPath;
    piSessionName = session.sessionName;
    actualModelOverride = session.model ? `${session.model.provider}/${session.model.modelId}` : undefined;
    actualThinkingLevelOverride = session.thinkingLevel ?? undefined;
  } else {
    await workerPool.spawn(sessionId, agent.workspacePath);
    session.agentId = agent.id;
    // Session-row-wins on respawn (session-lifecycle: "session 恢复：完全读 sessions 表，
    // 不读 agent 表"). The row snapshots agent config at creation; later session-level
    // edits (model / thinkingLevel / config) must survive worker death. Without these
    // overrides respawn silently reverted to agent values AND wrote them back over the
    // row (pre-existing bug, found via callserver session.restart testing).
    const existingRow = sessionRepo.get(sessionId);
    const runtimeConfig = buildRuntimeConfig(agent, existingRow
      ? {
          model: existingRow.model || undefined,
          thinkingLevel: existingRow.thinkingLevel,
          config: existingRow.config,
        }
      : undefined);
    const result = await workerPool.call<CreateSessionResult>(
      sessionId,
      'createSession',
      [runtimeConfig, sessionId, existingSessionPath],
    );
    piSessionPath = result.piSessionPath;
    piSessionName = result.sessionName;
    actualModelOverride = result.model ? `${result.model.provider}/${result.model.modelId}` : undefined;
    actualThinkingLevelOverride = result.thinkingLevel ?? undefined;
    session.piSessionPath = piSessionPath;
    session.model = result.model ?? null;
    session.thinkingLevel = result.thinkingLevel ?? null;
    session.sessionName = result.sessionName;
    await cacheSystemPrompt(session, workerPool);
  }

  const existing = sessionRepo.get(sessionId);
  // For an existing row, the row's model IS the session's model (it was fed to
  // createSession above) — only refresh from the worker's resolution; never
  // clobber a row with agent.model.
  const actualModel = existing ? (actualModelOverride ?? existing.model) : (actualModelOverride ?? agent.model);
  const created = existing
    ? sessionRepo.update(sessionId, { model: actualModel }) ?? sessionRepo.get(sessionId)
    : sessionRepo.createFromAgent({
        sessionId,
        agentId: agent.id,
        piSessionPath,
        modelOverride: actualModel,
      });

  if (!created) {
    await workerPool.kill(sessionId, 'create-failed');
    return undefined;
  }
  session.hasRow = true; // excluded from placeholder timeout / LRU eviction

  // ── Heal (session-title-sync, design D5): converge pi-native name to DB title ──
  // Equal (incl. both empty) → skip: no extra jsonl entry on every respawn.
  // Diverged → DB wins via setSessionName; covers worker-dead renames (direct DB
  // write) and legacy drift. Runs before the caller dispatches the prompt.
  await healPiSessionName(sessionId, workerPool, created.title, piSessionName);

  return { piSessionPath };
}

/**
 * Heal the pi-native session name toward the DB title (DB wins — design D5).
 * - db === pi (incl. both empty) → no-op (idempotent; avoids jsonl entry spam).
 * - both set but different → info-log the conflict, then overwrite pi with DB.
 * Placeholder sessions never reach this: heal only runs inside spawnAndCreate,
 * which always has a row by the time it executes.
 */
async function healPiSessionName(
  sessionId: string,
  workerPool: WorkerPool,
  dbTitle: string | undefined,
  piName: string | undefined,
): Promise<void> {
  const db = (dbTitle ?? '').trim();
  const pi = (piName ?? '').trim();
  if (db === pi) return;
  if (db && pi) {
    logger.info({ sessionId, dbTitle: db, piName: pi }, 'session title conflict: DB wins (heal)');
  }
  try {
    await workerPool.call(sessionId, 'setSessionName', [db]);
    logger.debug({ sessionId, title: db || null }, 'healed pi session name from DB title');
  } catch (err) {
    logger.warn({ err, sessionId }, 'heal setSessionName failed');
  }
}

function buildRuntimeConfig(
  agent: AgentLike,
  /** Session-row overrides (respawn path): row wins over agent (full-snapshot semantics). */
  sessionOverrides?: { model?: string; thinkingLevel?: string | null; config?: AgentConfig | null },
): RuntimeConfig {
  // Merge agent config with global defaults from settings.json
  const mergedConfig = mergeWithGlobalDefaults(
    sessionOverrides && sessionOverrides.config !== null && sessionOverrides.config !== undefined
      ? sessionOverrides.config
      : agent.config,
  );
  return {
    workspacePath: agent.workspacePath,
    model: sessionOverrides?.model || agent.model,
    thinkingLevel: sessionOverrides?.thinkingLevel ?? agent.thinkingLevel,
    config: mergedConfig,
    // Capability index (callserver-control-plane D2): compact method+summary list
    // pushed at spawn so the callServer tool description can embed it (registry
    // on master is the single source of truth; next spawn picks up changes).
    // Filtered by the EFFECTIVE authorization (session row key > agent fallback —
    // the exact resolver dispatch uses), so the description lists only methods
    // this session may actually call.
    capabilityIndex: buildCapabilityIndex(
      resolveEffectiveCapabilities(sessionOverrides?.config, agent.config),
    ),
  };
}

/**
 * Merge agent config with global defaults from settings.json.
 * When agent config field is null/undefined, use the global default.
 * When agent config field is set (including empty array), use it as-is.
 */
function mergeWithGlobalDefaults(agentConfig?: AgentConfig): AgentConfig | undefined {
  const globalSettings = readSettings();
  
  // No global defaults configured — return agent config as-is
  if (!globalSettings) return agentConfig;
  
  // No agent config — create one with just global defaults
  if (!agentConfig) {
    return {
      builtinTools: globalSettings.defaultBuiltinTools,
      serverBuiltinTools: globalSettings.defaultServerBuiltinTools,
      extensions: globalSettings.defaultExtensions,
      skills: globalSettings.defaultSkills,
      prompts: globalSettings.defaultPrompts,
    };
  }
  
  // Merge: agent config fields take precedence, fall back to global defaults
  return {
    ...agentConfig,
    builtinTools: agentConfig.builtinTools ?? globalSettings.defaultBuiltinTools,
    serverBuiltinTools: agentConfig.serverBuiltinTools ?? globalSettings.defaultServerBuiltinTools,
    extensions: agentConfig.extensions ?? globalSettings.defaultExtensions,
    skills: agentConfig.skills ?? globalSettings.defaultSkills,
    prompts: agentConfig.prompts ?? globalSettings.defaultPrompts,
  };
}

/**
 * Fetch the worker's system prompt over IPC and cache it on the Session.
 * Used after createSession so /:id/context can return the full prompt text
 * without re-fetching ~10K+ chars on every context call.
 */
async function cacheSystemPrompt(session: Session, workerPool: WorkerPool): Promise<void> {
  try {
    const sp = await workerPool.call<{ text: string; length: number; source: 'override' | 'default' }>(
      session.id,
      'getSystemPrompt',
      [],
    );
    if (sp) session.systemPrompt = sp;
  } catch (err) {
    // Non-fatal: /:id/context will just omit systemPrompt for this session.
    logger.warn({ err, sessionId: session.id }, 'cacheSystemPrompt failed');
  }
}

export type { AgentLike };

// ═══════════════════════════════════════════════════════════════════════
// Session / SessionRegistry (core-session-refactor Phase B)
// ═══════════════════════════════════════════════════════════════════════

export interface SessionRegistryDeps {
  sessionRepo: SessionRepo;
  agentRepo: AgentRepo;
  workerPool: WorkerPool;
}

/** Result of a session-level builtin command (task 2.7). */
export type CommandOutcome =
  | { handled: false }
  | { handled: true; ok: true; text: string }
  | { handled: true; ok: false; error: string; code: string };

/** Surface texts for executeCommand — HTTP defaults to English, IM passes 'zh'. */
type CommandLang = 'en' | 'zh';

const COMMAND_TEXTS: Record<CommandLang, {
  modelUsage: string;
  modelSet: (m: string) => string;
  thinkUsage: string;
  thinkSet: (level: string) => string;
  compactDone: string;
  nameUsage: (title: string | null) => string;
  nameRenamed: (t: string) => string;
  nameTooLong: string;
  notActive: string;
}> = {
  en: {
    modelUsage: 'Usage: /model <provider>/<modelId>',
    modelSet: (m) => `Model set to \`${m}\``,
    thinkUsage: 'Usage: /think <off|low|medium|high>',
    thinkSet: (l) => `Thinking level set to \`${l}\``,
    compactDone: 'Session context compacted.',
    nameUsage: (t) => `Current title: ${t ?? '(untitled)'}\n\nUsage: /name <title>`,
    nameRenamed: (t) => `Session renamed to \`${t}\``,
    nameTooLong: 'Title too long (max 200 chars)',
    notActive: 'Session not active (send a message first)',
  },
  zh: {
    modelUsage: '用法: /model <provider/model>\n例: /model openai/gpt-4o',
    modelSet: (m) => `已切到 model: ${m}`,
    thinkUsage: '用法: /think <off|low|medium|high>',
    thinkSet: (l) => `已切到 thinking: ${l}`,
    compactDone: '已请求 compact',
    nameUsage: (t) => `当前标题: ${t ?? '(未命名)'}\n\n用法: /name <标题>`,
    nameRenamed: (t) => `Session 已重命名为 \`${t}\``,
    nameTooLong: '标题过长（最多 200 字符）',
    notActive: '当前 session 未激活（请先发送消息）',
  },
};

/**
 * Session — domain object for one session id.
 *
 * OWNS the domain state migrated off WorkerEntry (task 2.3):
 * hasRow / model / thinkingLevel / sessionName / systemPrompt /
 * piSessionPath / agentId. WorkerEntry keeps process facts only.
 *
 * Object lifetime (design D2): tracked by the registry from just BEFORE
 * spawn until dispose (worker death / delete / timeout / LRU — wired via the
 * pool's 'crash' event). A workerless object may exist while SSE clients hold
 * a subscription (track()); it is dropped when the last subscriber leaves.
 *
 * Event delivery (task 2.4): pool emits `session_event` for every worker
 * event; each Session attaches ONE filtered handler. No buffering machinery —
 * listeners live on the object, so events flow whenever a worker exists for
 * this id (pre-spawn subscriptions included — there is nothing to buffer).
 */
export class Session {
  readonly id: string;

  // ── Domain state (migrated from WorkerEntry — task 2.3) ──
  /** True once the session has a persisted DB row. Placeholders (false)
   *  participate in the placeholder timeout + LRU eviction. */
  hasRow = false;
  /** Actual model the worker is using (set after createSession / setModel). */
  model: { provider: string; modelId: string } | null = null;
  /** Active thinking level on the worker. */
  thinkingLevel: 'off' | 'low' | 'medium' | 'high' | null = null;
  /** pi-native session display name (createSession result; heal input). */
  sessionName?: string;
  /** Cached system prompt for /:id/context (avoids ~10K-char IPC refetch). */
  systemPrompt: { text: string; length: number; source: 'override' | 'default' } | null = null;
  /** Path to the pi session file (createSession result; respawn history input). */
  piSessionPath?: string;
  /** Owning agent (set at spawn; resolves ctx.agentId for rowless placeholders). */
  agentId?: string;

  private readonly listeners = new Map<(event: WorkerEvent) => void, ((reason: string) => void) | undefined>();
  private disposed = false;
  /** Registry hook: fired when the last subscriber leaves a workerless object. */
  onOrphaned?: () => void;

  constructor(id: string, private readonly deps: SessionRegistryDeps) {
    this.id = id;
  }

  /** Worker process currently alive. */
  get alive(): boolean {
    return this.deps.workerPool.has(this.id);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Subscribe to this session's worker events. Works with or without a live
   * worker (events only flow while one exists). Returns an idempotent
   * unsubscribe. `onDispose` fires when the object reaches its terminal state —
   * SSE uses it to close the stream (EventSource auto-reconnects → re-subscribes
   * to the next object), satisfying the dispose contract: subscribers are
   * notified AND cleared, no stale refs survive.
   */
  subscribe(
    listener: (event: WorkerEvent) => void,
    onDispose?: (reason: string) => void,
  ): () => void {
    if (this.disposed) {
      onDispose?.('already-disposed');
      return () => {};
    }
    this.listeners.set(listener, onDispose);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && !this.alive) this.onOrphaned?.();
    };
  }

  /** Registry-internal fan-out target for pool `session_event` (one pool
   *  listener total — avoids EventEmitter max-listener churn). */
  deliver(event: WorkerEvent): void {
    if (this.disposed) return;
    for (const [listener] of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.warn({ err, sessionId: this.id }, 'session event listener threw');
      }
    }
  }

  /** Terminal state: notify every subscriber and clear them. */
  notifyDisposed(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [, onDispose] of this.listeners) {
      try {
        onDispose?.(reason);
      } catch (err) {
        logger.warn({ err, sessionId: this.id, reason }, 'dispose notifier threw');
      }
    }
    this.listeners.clear();
  }

  /**
   * Session-level builtin commands (task 2.7): builtin short-circuit for the
   * stateful ops (model / think / compact / name). Returns `{handled:false}`
   * for anything else — the CALLER owns the fallthrough (HTTP → worker
   * dispatchCommand, IM → agent prompt), preserving each surface's semantics.
   * `lang` selects surface texts (HTTP English default, IM 'zh').
   */
  async executeCommand(name: string, args: string, lang: CommandLang = 'en'): Promise<CommandOutcome> {
    const T = COMMAND_TEXTS[lang];
    const n = name.toLowerCase().replace(/^\//, '');
    switch (n) {
      case 'model': {
        // Alive-check FIRST — matches HTTP's needsWorker ordering (dead + bad
        // args → session_not_active, not usage text). IM guarantees alive via
        // ensureSession before dispatching commands.
        if (!this.alive) return { handled: true, ok: false, error: T.notActive, code: 'session_not_active' };
        const slashIdx = args.indexOf('/');
        if (slashIdx <= 0 || !args.slice(slashIdx + 1)) {
          return { handled: true, ok: true, text: T.modelUsage };
        }
        const provider = args.slice(0, slashIdx);
        const modelId = args.slice(slashIdx + 1);
        await this.deps.workerPool.call(this.id, 'setModel', [provider, modelId]);
        this.model = { provider, modelId };
        this.deps.sessionRepo.update(this.id, { model: args });
        return { handled: true, ok: true, text: T.modelSet(args) };
      }
      case 'think':
      case 'thinking': {
        const VALID = ['off', 'low', 'medium', 'high'];
        const level = args.toLowerCase();
        if (!VALID.includes(level)) {
          return { handled: true, ok: true, text: T.thinkUsage };
        }
        if (!this.alive) return { handled: true, ok: false, error: T.notActive, code: 'session_not_active' };
        await this.deps.workerPool.call(this.id, 'setThinkingLevel', [level]);
        // OQ-D2: master cache only — NOT persisted to sessions.thinkingLevel
        // (matches POST /:id/think endpoint semantics).
        this.thinkingLevel = level as 'off' | 'low' | 'medium' | 'high';
        return { handled: true, ok: true, text: T.thinkSet(level) };
      }
      case 'compact': {
        if (!this.alive) return { handled: true, ok: false, error: T.notActive, code: 'session_not_active' };
        await this.deps.workerPool.call(this.id, 'compact', []);
        return { handled: true, ok: true, text: T.compactDone };
      }
      case 'name': {
        const row = this.deps.sessionRepo.get(this.id);
        if (!row) {
          return { handled: true, ok: false, error: 'Session not found', code: 'session_not_found' };
        }
        if (!args) return { handled: true, ok: true, text: T.nameUsage(row.title ?? null) };
        if (args.length > 200) {
          return { handled: true, ok: false, error: T.nameTooLong, code: 'title_too_long' };
        }
        await renameSessionOp({ sessionRepo: this.deps.sessionRepo, workerPool: this.deps.workerPool }, this.id, args);
        return { handled: true, ok: true, text: T.nameRenamed(args) };
      }
      case 'session': {
        // Read-only session info (HTTP surface; IM keeps its own gate-level /session).
        const row = this.deps.sessionRepo.get(this.id);
        if (!row) {
          return { handled: true, ok: true, text: 'This session is a placeholder — send a message to activate it.' };
        }
        const content = [
          `**Session** \`${row.id.slice(0, 8)}\``,
          `- Status: ${row.status}`,
          `- Title: ${row.title ?? '(untitled)'}`,
          `- Model: ${row.model}`,
          `- Thinking: ${row.thinkingLevel ?? '(default)'}`,
          `- Worker: ${this.alive ? 'running' : 'not running'}`,
          `- Created: ${new Date(row.createdAt).toLocaleString()}`,
        ].join('\n');
        return { handled: true, ok: true, text: content };
      }
      case 'hotkeys': {
        return {
          handled: true,
          ok: true,
          text: [
            '**Keyboard shortcuts**',
            '- `Enter` — send message',
            '- `Shift+Enter` — newline',
            '- `/` — open slash command menu',
            '- `@` — reference a file',
            '- `Esc` — close menu',
          ].join('\n'),
        };
      }
      default:
        return { handled: false };
    }
  }
}

/**
 * SessionRegistry — SOLE entry for session spawn/revive (design D3/D4).
 *
 * - getOrCreate(id, agent): memory-hit (object alive + row present) → return;
 *   else row-aware spawnAndCreate. Concurrent first-calls share ONE inflight
 *   promise (D4); failures are NOT cached (finally clears).
 * - createFromAgent(agentId): newSessionId + placeholder spawn, NO row —
 *   HTTP two-phase creation; kills a partial worker on spawn failure.
 * - track(id): get-or-create a WORKERLESS object (SSE / repo-only commands
 *   must not spawn). getOrCreate reuses the tracked object when spawning.
 * - dispose(id, reason): terminal — notify+clear subscribers, remove object.
 *   Wired to the pool's 'crash' event (fires on EVERY worker exit), so an
 *   object never crosses a worker death (design D2).
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly inflight = new Map<string, Promise<Session | undefined>>();

  constructor(private readonly deps: SessionRegistryDeps) {
    // ONE pool listener fans out to the tracked Session (each object attaches
    // its own would hit EventEmitter's max-listener warning at ~10 sessions).
    deps.workerPool.on('session_event', (sessionId: string, event: WorkerEvent) => {
      this.sessions.get(sessionId)?.deliver(event);
    });
    // Every worker death → object terminal (notify subscribers → SSE closes →
    // client auto-reconnects → re-subscribes to the next object).
    deps.workerPool.on('crash', (sessionId: string) => {
      this.dispose(sessionId, 'worker-death');
    });
  }

  /** Ensure the session exists: revive an existing row, or persist a fresh one. */
  async getOrCreate(sessionId: string, agent: AgentLike): Promise<Session | undefined> {
    const existing = this.inflight.get(sessionId);
    if (existing) return existing; // D4: concurrent first-calls share one spawn
    const promise = this.doGetOrCreate(sessionId, agent).finally(() => {
      this.inflight.delete(sessionId); // failure NOT cached — next call retries
    });
    this.inflight.set(sessionId, promise);
    return promise;
  }

  private async doGetOrCreate(sessionId: string, agent: AgentLike): Promise<Session | undefined> {
    const row = this.deps.sessionRepo.get(sessionId);
    const tracked = this.sessions.get(sessionId);
    // D3 memory-hit: object alive AND row present → nothing to do (fast path;
    // placeholder activation (alive, no row) must fall through to persist).
    if (tracked && tracked.alive && row && tracked.hasRow) return tracked;
    const session = tracked ?? this.track(sessionId); // object exists BEFORE spawn
    let result: { piSessionPath: string } | undefined;
    try {
      result = await spawnAndCreate(session, agent, this.deps.sessionRepo, this.deps.workerPool, row?.piSessionPath);
    } catch (err) {
      // Spawn/IPC failure: dispose notifies subscribers (SSE closes → client
      // reconnects) — never a silent raw delete. Keep the object only if a
      // worker survived (it may be reused by a retry).
      if (!this.deps.workerPool.has(sessionId)) this.dispose(sessionId, 'spawn-failed');
      throw err;
    }
    if (!result) {
      // Row write failed → spawnAndCreate killed the worker → 'crash' disposes.
      this.dispose(sessionId, 'create-failed');
      return undefined;
    }
    return session;
  }

  /**
   * Create a NEW placeholder session for an agent (two-phase HTTP flow):
   * generates the id, spawns the worker, writes NO DB row. The row is persisted
   * later by the first getOrCreate (first prompt).
   */
  async createFromAgent(agentId: string): Promise<Session> {
    const agent = this.deps.agentRepo.get(agentId);
    if (!agent) throw new Error(`Agent not found: ${agentId}`);
    const sessionId = this.deps.sessionRepo.newSessionId();
    const session = this.track(sessionId);
    try {
      await spawnPlaceholder(session, agent, this.deps.workerPool);
    } catch (err) {
      // Same cleanup the HTTP placeholder route did on spawn failure.
      if (this.deps.workerPool.has(sessionId)) {
        await this.deps.workerPool.kill(sessionId, 'spawn-failed');
      }
      this.dispose(sessionId, 'spawn-failed');
      throw err;
    }
    return session;
  }

  /** Get-or-create a WORKERLESS session object (subscription anchor for SSE /
   *  repo-only commands). Never spawns. */
  track(sessionId: string): Session {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session = new Session(sessionId, this.deps);
    session.onOrphaned = () => {
      // Last subscriber left a workerless object → nothing anchors it.
      if (this.sessions.get(sessionId) === session && !session.alive) {
        this.dispose(sessionId, 'no-listeners');
      }
    };
    this.sessions.set(sessionId, session);
    return session;
  }

  /** Drop the session object: notify + clear subscribers, remove from registry. */
  dispose(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    session.notifyDisposed(reason);
    logger.debug({ sessionId, reason }, 'session object disposed');
  }

  /** All currently tracked session objects. */
  list(): Session[] {
    return [...this.sessions.values()];
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }
}

// ── Module singleton (mirrors workerPool's module-singleton style) ──────────
let registry: SessionRegistry | undefined;

/** Called ONCE from main() right after repos are created. */
export function initSessionRegistry(deps: SessionRegistryDeps): SessionRegistry {
  registry = new SessionRegistry(deps);
  // Domain knowledge the pool needs for LRU eviction / list().hasRow /
  // timeout-scanner — injected here so worker-pool stays domain-free.
  deps.workerPool.setHasRowQuery((sessionId) => registry?.get(sessionId)?.hasRow ?? false);
  return registry;
}

export function sessionRegistry(): SessionRegistry {
  if (!registry) throw new Error('SessionRegistry not initialized — call initSessionRegistry() in main() first');
  return registry;
}
