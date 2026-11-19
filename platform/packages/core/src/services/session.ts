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
import { normalizeAgentConfig } from '@pi-agent-platform/shared-types';
import type { WorkerEvent } from '@pi-agent-platform/ipc-protocol';
import type { WorkerPool } from '../worker-pool.js';
import type { AgentRepo } from '../repos/agent.repo.js';
import type { SessionRepo } from '../repos/session.repo.js';
import { buildCapabilityIndex, resolveEffectiveCapabilities } from '../capabilities/registry.js';
import { renameSession as renameSessionOp } from './session-ops.js';
import { childLogger } from '../logger.js';
import type { SessionRunState } from '@pi-agent-platform/shared-types';
import type { WorkerPluginSpec } from '@pi-agent-platform/ipc-protocol';
import { coreConfig } from '../config.js';
import { extractExtensionNames, readSettings } from './extension-utils.js';
import { getPluginSnapshot, resolveSessionPlugins } from './plugins.js';

/**
 * Idle run state. Shared (frozen by convention) so responses for sessions without a
 * live Session object — placeholder, worker dead, archived — report "idle" instead of
 * omitting the field.
 */
export const IDLE_RUN_STATE: SessionRunState = Object.freeze({
  status: 'idle',
  startedAt: null,
  pendingSteer: 0,
  pendingFollowUp: 0,
}) as SessionRunState;

/** Current run state for a session id (copy — callers may embed it in a response). */
export function runStateOf(sessionId: string): SessionRunState {
  const live = registry?.get(sessionId);
  return live ? { ...live.run } : { ...IDLE_RUN_STATE };
}

const logger = childLogger('session');

/**
 * 解析该会话可用的插件集合（会话级闸门）。
 *
 * 入参是**将要下发给 worker 的那份 config**（会话行快照，或新会话时的 agent 配置），
 * 不是 agent 行本身 —— 这样 `config.extensions` 与插件集合必然同源，
 * respawn 时不会出现"config 用会话行、插件用 agent"的双源漂移。
 *
 * - 解析在 server 单点完成，结果随 `createSession` 一次性下发
 * - `requires.plugins` 只校验，不代用户启用
 * - 解析失败降为空集合，不阻断建会话
 */
async function resolvePluginsFromConfig(agentConfig: AgentConfig | undefined): Promise<WorkerPluginSpec[]> {
  try {
    const snapshot = getPluginSnapshot(coreConfig().pluginsDir);
    if (snapshot.disabledByFlag || snapshot.plugins.length === 0) return [];
    const settings = await readSettings(coreConfig().agentDir);
    const installed = extractExtensionNames(settings);
    const agentExtensions = agentConfig?.extensions ?? [];
    const resolved = resolveSessionPlugins({
      snapshot,
      enabledPlugins: agentConfig?.plugins ?? [],
      agentExtensions,
      installedPiExtensions: installed,
    });
    for (const p of resolved.filter((r) => !r.enabled && r.reason)) {
      logger.debug({ pluginId: p.id, reason: p.reason }, 'plugin gated off for session');
    }
    // 下发完整集合（含 disabled + reason）：worker 侧过滤并记日志，
    // 使单会话日志能解释"为什么没装载"。
    return resolved.map((p) => ({
      id: p.id,
      dir: p.dir,
      enabled: p.enabled,
      ...(p.reason ? { reason: p.reason } : {}),
      ...(p.extensionPath ? { extensionPath: p.extensionPath } : {}),
      ...(p.workerPath ? { workerPath: p.workerPath } : {}),
      ...((p.skillPaths?.length ?? 0) > 0 ? { skillPaths: p.skillPaths } : {}),
    }));
  } catch (err) {
    logger.error({ err: String(err) }, 'plugin resolution failed — session continues without plugins');
    return [];
  }
}

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
  const runtimeConfig = await buildRuntimeConfig(agent, sessionId);
  session.plugins = runtimeConfig.plugins ?? [];
  const result = await workerPool.call<CreateSessionResult>(sessionId, 'createSession', [runtimeConfig]);
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
    const runtimeConfig = await buildRuntimeConfig(
      agent,
      sessionId,
      existingRow
        ? {
            model: existingRow.model || undefined,
            thinkingLevel: existingRow.thinkingLevel,
            config: existingRow.config,
          }
        : undefined,
      existingSessionPath,
    );
    session.plugins = runtimeConfig.plugins ?? [];
    const result = await workerPool.call<CreateSessionResult>(sessionId, 'createSession', [runtimeConfig]);
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

/**
 * Build the ONE payload a session gets at spawn — the single assembly entry.
 *
 * Everything in segment ① comes from the session row (or, for a brand-new session,
 * from the agent it was created from); `workspacePath` is the only field that always
 * comes from the agent. `plugins` is derived from `runtimeConfig.config.extensions`
 * here, so callers cannot supply a second, divergent plugin list.
 */
async function buildRuntimeConfig(
  agent: AgentLike,
  sessionId: string,
  /** Session-row overrides (respawn path): row wins over agent (full-snapshot semantics). */
  sessionOverrides?: { model?: string; thinkingLevel?: string | null; config?: AgentConfig | null },
  existingSessionPath?: string,
): Promise<RuntimeConfig> {
  // Normalize to the explicit-clist contract (change: explicit-agent-config):
  // missing/null resource fields become empty, `mcp` becomes { enabled: false }.
  // There is deliberately NO global-default merge layer — the agent/session row is the
  // single source of truth (`~/.pi/server/config.json` no longer feeds agent config).
  const sourceConfig =
    sessionOverrides && sessionOverrides.config !== null && sessionOverrides.config !== undefined
      ? sessionOverrides.config
      : agent.config;
  const resolvedConfig = normalizeAgentConfig(sourceConfig);
  // ③ Derived: plugins come from the same `extensions` list we just handed the worker.
  const plugins = await resolvePluginsFromConfig(resolvedConfig);
  return {
    // ① Row-aligned segment
    sessionId,
    model: sessionOverrides?.model || agent.model,
    thinkingLevel: sessionOverrides?.thinkingLevel ?? agent.thinkingLevel,
    config: resolvedConfig,
    ...(existingSessionPath ? { existingSessionPath } : {}),
    // ② Platform-injected segment (never persisted)
    workspacePath: agent.workspacePath,
    // Capability index (callserver-control-plane D2): compact method+summary list
    // pushed at spawn so the callServer tool description can embed it (registry
    // on master is the single source of truth; next spawn picks up changes).
    // Filtered by the EFFECTIVE authorization (session row key > agent fallback —
    // the exact resolver dispatch uses), so the description lists only methods
    // this session may actually call.
    capabilityIndex: buildCapabilityIndex(
      resolveEffectiveCapabilities(sessionOverrides?.config, agent.config),
    ),
    // ③ Derived segment
    plugins,
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

/** 每个订阅者的待发队列上限。超了就丢最旧的（事件可丢，回压不可接受）。 */
const SUBSCRIBER_QUEUE_LIMIT = 256;

interface ListenerSlot {
  listener: (event: WorkerEvent) => void;
  onDispose?: (reason: string) => void;
  /** 待投递事件（有界）。 */
  queue: WorkerEvent[];
  /** 已丢弃条数（诊断）。 */
  dropping: number;
  /** 是否已经为丢弃打过一次 warn（避免刷日志）。 */
  warned: boolean;
  /** 是否正在排空（防止并发排空导致乱序）。 */
  draining: boolean;
}

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
  /**
   * 本次 spawn 实际下发给 worker 的插件集合（含 `enabled: false` + reason）。
   *
   * 这是"该会话有哪些插件"的**唯一真值**：任何查询接口都必须读它，不能拿 agent 的
   * 当前 `extensions` 重新解析 —— 那样会和 worker 实际装载的集合漂移（会话是快照）。
   */
  plugins: WorkerPluginSpec[] = [];
  /**
   * Runtime run state (change: session-streaming-runtime).
   *
   * The single source of truth for "is a turn running right now": updated from the
   * worker event stream in `deliver()` (below) and read by REST routes + the SSE
   * `session_snapshot` frame. Never derived from the DB.
   */
  run: SessionRunState = { ...IDLE_RUN_STATE };

  private readonly listeners = new Map<ListenerSlot, ((reason: string) => void) | undefined>();
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
    const slot: ListenerSlot = { listener, onDispose, queue: [], dropping: 0, warned: false, draining: false };
    this.listeners.set(slot, onDispose);
    return () => {
      this.listeners.delete(slot);
      if (this.listeners.size === 0 && !this.alive) this.onOrphaned?.();
    };
  }

  /**
   * Registry-internal fan-out target for pool `session_event`（全池共享一个监听器，
   * 避免 EventEmitter 的 max-listener 抖动）。
   *
   * **慢订阅者策略：丢弃，不回压。**
   * 每个订阅者有一条有界的待发队列，由 `setImmediate` 异步排空。队列满了就丢**最旧**
   * 的一条并计数（首次丢弃记一条 warn）。理由：事件是 UI 增量、本身可丢（与"事件无
   * 回执"同语义），而为慢订阅者排队会让一个卡住的消费者拖住整条流。需要确认的操作走
   * 的是请求-响应通道（`prompt` / `abort`），不受影响。
   */
  deliver(event: WorkerEvent): void {
    if (this.disposed) return;
    this.trackRunState(event);
    for (const slot of this.listeners.keys()) {
      slot.queue.push(event);
      if (slot.queue.length > SUBSCRIBER_QUEUE_LIMIT) {
        slot.queue.shift();
        slot.dropping += 1;
        if (!slot.warned) {
          slot.warned = true;
          logger.warn(
            { sessionId: this.id, dropping: slot.dropping, limit: SUBSCRIBER_QUEUE_LIMIT, event: event.event },
            'slow subscriber: dropping events (no backpressure)',
          );
        }
      }
      if (slot.draining) continue;
      slot.draining = true;
      setImmediate(() => this.drain(slot));
    }
  }

  /** 排空一个订阅者的队列（一次一个事件，保持顺序）。 */
  private drain(slot: ListenerSlot): void {
    while (slot.queue.length > 0) {
      const next = slot.queue.shift()!;
      try {
        slot.listener(next);
      } catch (err) {
        logger.warn({ err, sessionId: this.id }, 'session event listener threw');
      }
      if (this.disposed) break;
    }
    slot.draining = false;
  }

  /** Fold lifecycle events into `run` (see SessionRunState). */
  private trackRunState(event: WorkerEvent): void {
    switch (event.event) {
      case 'agent_start': {
        const startedAt = (event.data as { startedAt?: unknown } | undefined)?.startedAt;
        this.run = {
          ...this.run,
          status: 'running',
          startedAt: typeof startedAt === 'number' ? startedAt : Date.now(),
        };
        break;
      }
      case 'agent_settled':
        // Authoritative end of a run: status back to idle, counters cleared.
        this.run = { ...IDLE_RUN_STATE };
        break;
      case 'queue_update': {
        const data = event.data as { steering?: unknown[]; followUp?: unknown[] } | undefined;
        this.run = {
          ...this.run,
          pendingSteer: Array.isArray(data?.steering) ? data.steering.length : 0,
          pendingFollowUp: Array.isArray(data?.followUp) ? data.followUp.length : 0,
        };
        break;
      }
      default:
        break;
    }
  }

  /** Terminal state: notify every subscriber and clear them. */
  notifyDisposed(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    // A dead worker is never "running": force idle so clients never hang in a
    // spinner waiting for a settle event that will not come.
    this.run = { ...IDLE_RUN_STATE };
    for (const [slot, onDispose] of this.listeners) {
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
  /** 会话创建 / 终结的观察钩子（插件与平台功能用，不参与会话编排）。 */
  private readonly createdHooks = new Set<(sessionId: string, agentId: string) => void>();
  private readonly disposedHooks = new Set<(sessionId: string, reason: string) => void>();

  /** 订阅"新会话已创建"。返回退订。 */
  onSessionCreated(hook: (sessionId: string, agentId: string) => void): () => void {
    this.createdHooks.add(hook);
    return () => this.createdHooks.delete(hook);
  }

  /** 订阅"会话进入终态"。返回退订。 */
  onSessionDisposed(hook: (sessionId: string, reason: string) => void): () => void {
    this.disposedHooks.add(hook);
    return () => this.disposedHooks.delete(hook);
  }

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
    for (const hook of this.createdHooks) {
      try {
        hook(session.id, session.agentId ?? '');
      } catch (err) {
        logger.warn({ err, sessionId: session.id }, 'onSessionCreated hook threw');
      }
    }
    return session;
  }

  /**
   * 取一个**可用**会话（插件侧"无人值守跑一轮"的入口）。
   *
   * 三态语义与旧 trigger `resolveSession()` 逐条一致：
   * - 无 `sessionId` → 新建（createFromAgent 拿 id + 占位 worker，再 getOrCreate 落行）
   * - 有 `sessionId` → 行必须存在且同 agent（否则抛错，fail closed —— `getOrCreate`
   *   对陌生 id 会照建一个，不校验就会静默写到别人的会话里），然后懒恢复
   * - `title` 只在新建时写（归因用，不动 sessions schema）
   */
  async ensure(input: {
    agentId: string;
    sessionId?: string;
    title?: string;
  }): Promise<{ sessionId: string; created: boolean }> {
    const agent = this.deps.agentRepo.get(input.agentId);
    if (!agent) throw new Error(`agent not found: ${input.agentId}`);

    if (input.sessionId) {
      const bound = input.sessionId;
      const row = this.deps.sessionRepo.get(bound);
      if (!row) throw new Error(`session not found (deleted?): ${bound}`);
      if (row.agentId !== input.agentId) {
        throw new Error(`session ${bound} does not belong to agent ${input.agentId}`);
      }
      const revived = await this.getOrCreate(bound, agent);
      if (!revived) throw new Error(`failed to revive session ${bound}`);
      return { sessionId: bound, created: false };
    }

    const session = await this.createFromAgent(input.agentId);
    const persisted = await this.getOrCreate(session.id, agent);
    if (!persisted) throw new Error(`failed to persist session ${session.id}`);
    if (input.title) this.deps.sessionRepo.update(session.id, { title: input.title });
    return { sessionId: session.id, created: true };
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
    for (const hook of this.disposedHooks) {
      try {
        hook(sessionId, reason);
      } catch (err) {
        logger.warn({ err, sessionId }, 'onSessionDisposed hook threw');
      }
    }
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
