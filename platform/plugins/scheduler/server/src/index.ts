/**
 * 定时任务（bundled 插件）。
 *
 * 职责：按时间把一条任务 prompt 送进 agent 的会话。**到此为止** ——
 * run 的 `status` 只表示"消息有没有送进 agent"，agent 干得怎么样不归这里管
 * （要不要汇报、汇报给谁，是 agent 自己 prompt / 工具的事）。
 *
 * 与旧触发器子系统（已删除）的关系：cron / once、会话绑定三态、max_runs、
 * overlap、停机只记 missed 不补跑、僵尸 run 收尾、抢占唯一 —— 逐条保留；
 * **webhook 不迁**（那是另一个插件的事）。
 *
 * 生命周期：调度器 timer 挂在 `init()`，`dispose()` 清 —— 热加载必须能归零。
 */

import type { PluginRouteHandler, PluginServerHost } from '@pi-agent-platform/plugin-types';
import { isValidTimeZone, MIN_CRON_INTERVAL_MINUTES, nextCronTime, parseCronExpr } from './cron.js';
import { createStore, DDL, OVERLAP_WINDOW_MS, type SchedulerStore } from './store.js';
import type { RunTrigger, ScheduleKind, SessionMode, TaskDTO } from './types.js';

/** 一次性任务允许的"刚好过去"宽限（秒级抖动不该被拒）。 */
const ONCE_GRACE_MS = 30_000;
/** 停机期间跨过的 slot 收敛成一条 missed 后，最多再往前找多少个未来 slot。 */
const MAX_CATCHUP_SLOTS = 500;

const TASK_ID_PREFIX = 'task_';

interface CreateTaskInput {
  agentId?: string;
  name?: string;
  prompt?: string;
  scheduleKind?: ScheduleKind;
  cronExpr?: string;
  timezone?: string;
  at?: number;
  sessionMode?: SessionMode;
  sessionId?: string;
  maxRuns?: number | null;
}

interface UpdateTaskInput extends CreateTaskInput {
  enabled?: boolean;
  reschedule?: boolean;
}

export default {
  init(host: PluginServerHost) {
    // ── R4：自己的表 ──
    host.db.migrate('scheduler', DDL);
    const store = createStore(host.db);

    // ── 启动收敛：僵尸 run + 错过的 slot ──
    const staleCount = store.finalizeStaleRuns();
    if (staleCount > 0) host.log('warn', `收尾 ${staleCount} 条僵尸 run（进程崩溃残留）`);
    catchUpMissed(host, store);

    // ── 调度器 ──
    const scheduler = createScheduler(host, store);

    // ── R3：反向方法（extension facet 的 `schedule_task` 工具经此调用）──
    host.methods.handle('task.list', (params) => {
      const p = (params ?? {}) as { agentId?: string; includeDisabled?: boolean };
      return { items: store.list({ agentId: p.agentId, includeDisabled: p.includeDisabled }) };
    });
    host.methods.handle('task.create', async (params, ctx) => {
      const p = { ...(params as CreateTaskInput) };
      // agentId 缺省取调用方的 agent —— worker 侧不知道自己在哪个 agent 上，也不该猜。
      if (!p.agentId) {
        const callerAgent = ctx.sessionId ? (await host.sessions.get(ctx.sessionId))?.agentId : undefined;
        if (callerAgent) p.agentId = callerAgent;
      }
      const { task } = await createTask(host, store, p);
      scheduler.rearm();
      return task;
    });
    host.methods.handle('task.update', async (params) => {
      const p = (params ?? {}) as { taskId?: string } & UpdateTaskInput;
      if (!p.taskId) throw new Error('taskId is required');
      const task = await updateTask(host, store, p.taskId, p);
      scheduler.rearm();
      return task;
    });
    host.methods.handle('task.delete', (params) => {
      const p = (params ?? {}) as { taskId?: string };
      if (!p.taskId) throw new Error('taskId is required');
      store.remove(p.taskId);
      scheduler.rearm();
      return { ok: true };
    });
    host.methods.handle('task.run', async (params) => {
      const p = (params ?? {}) as { taskId?: string };
      if (!p.taskId) throw new Error('taskId is required');
      return dispatch(host, store, p.taskId, 'plugin');
    });

    // ── R2：REST ──
    const route = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, handler: PluginRouteHandler): void => {
      host.http.route({ method, path, handler });
    };

    route('GET', '/tasks', (req) => ({
      json: { items: store.list({ agentId: req.query.agentId, includeDisabled: req.query.includeDisabled === '1' }) },
    }));

    route('GET', '/tasks/:id', (req) => {
      const task = store.get(req.params.id!);
      if (!task) return { status: 404, json: { error: 'task not found' } };
      return { json: { task, runs: store.listRuns(task.id, 50) } };
    });

    route('POST', '/tasks', async (req) => {
      try {
        const { task } = await createTask(host, store, parseBody(req.body) as CreateTaskInput);
        scheduler.rearm();
        return { status: 201, json: task };
      } catch (err) {
        return { status: 400, json: { error: messageOf(err) } };
      }
    });

    const updateHandler: PluginRouteHandler = async (req) => {
      try {
        const task = await updateTask(host, store, req.params.id!, parseBody(req.body) as UpdateTaskInput);
        scheduler.rearm();
        return { json: task };
      } catch (err) {
        const msg = messageOf(err);
        return { status: msg.includes('max_runs') || msg.includes('上限') ? 409 : 400, json: { error: msg } };
      }
    };
    // PATCH 是语义正确的动词；PUT 挂在同一处理器上，因为插件 web 面的 api 只有
    // get/post/put/del（不给 patch）—— 为了不必要的严格而让插件写不了自己的 UI 不值得。
    route('PATCH', '/tasks/:id', updateHandler);
    route('PUT', '/tasks/:id', updateHandler);

    route('DELETE', '/tasks/:id', (req) => {
      store.remove(req.params.id!);
      scheduler.rearm();
      return { json: { ok: true } };
    });

    route('POST', '/tasks/:id/run', async (req) => {
      const result = await dispatch(host, store, req.params.id!, 'manual');
      const status = result.status === 'delivered' ? 202 : result.status === 'skipped' ? 409 : 400;
      return { status, json: result };
    });

    route('GET', '/tasks/:id/runs', (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
      return { json: { items: store.listRuns(req.params.id!, limit) } };
    });

    // 编辑器需要的元数据：agent 列表（插件 web 面只能打自己的前缀，不能直连平台 API）
    route('GET', '/meta', async () => ({
      json: {
        agents: (await host.agents.list()).map((a) => ({ id: a.id, name: a.name })),
        defaultTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        minIntervalMinutes: MIN_CRON_INTERVAL_MINUTES,
        now: Date.now(),
      },
    }));

    // `reuse` 模式下选目标会话：只列该 agent 的会话
    route('GET', '/sessions', async (req) => {
      const agentId = req.query.agentId;
      const items = (await host.sessions.list())
        .filter((s) => (agentId ? s.agentId === agentId : true))
        .map((s) => ({ id: s.id, agentId: s.agentId, status: s.status }));
      return { json: { items } };
    });

    // 计划校验 + 下次运行预览（编辑器用，避免把 cron 规则复制到前端）
    route('POST', '/preview', (req) => {
      const body = parseBody(req.body) as { scheduleKind?: ScheduleKind; cronExpr?: string; timezone?: string; at?: number };
      try {
        const nextAt = computeNextAt(body, Date.now());
        return { json: { ok: true, nextAt } };
      } catch (err) {
        return { status: 400, json: { ok: false, error: messageOf(err) } };
      }
    });

    // ── R1：页面 ──
    host.ui.page({ path: '/scheduler', label: '定时任务', icon: 'automation', component: 'list', order: 15 });
    host.ui.page({ path: '/scheduler/new', label: '新建定时任务', icon: 'automation', component: 'editor', nav: false });
    host.ui.page({ path: '/scheduler/:id', label: '定时任务', icon: 'automation', component: 'editor', nav: false });

    scheduler.start();

    return () => {
      scheduler.dispose();
    };
  },
};

// ────────────────────────────── 计划计算 ──────────────────────────────

function computeNextAt(
  input: { scheduleKind?: ScheduleKind; cronExpr?: string; timezone?: string; at?: number },
  from: number,
): number | null {
  if (input.scheduleKind === 'once') {
    const at = Number(input.at);
    if (!Number.isFinite(at)) throw new Error('at 必须是毫秒时间戳');
    if (at < from - ONCE_GRACE_MS) throw new Error('一次性任务的时间必须是将来的时刻');
    return at;
  }
  if (input.scheduleKind !== 'cron') throw new Error('scheduleKind 只能是 cron 或 once');
  const expr = (input.cronExpr ?? '').trim();
  if (!expr) throw new Error('cron 表达式不能为空');
  const tz = (input.timezone ?? '').trim();
  if (!tz) throw new Error('时区不能为空');
  if (!isValidTimeZone(tz)) throw new Error(`未知时区：${tz}`);
  // 语法与最小间隔都在这里判：非法表达式不该等到创建后第一次调度才炸。
  parseCronExpr(expr);
  const first = nextCronTime(expr, tz, from);
  if (first === null) throw new Error('cron 表达式永远不会触发');
  const second = nextCronTime(expr, tz, first);
  if (second !== null && second - first < MIN_CRON_INTERVAL_MINUTES * 60_000) {
    throw new Error(`cron 最小间隔是 ${MIN_CRON_INTERVAL_MINUTES} 分钟`);
  }
  return first;
}

// ────────────────────────────── 任务 CRUD ──────────────────────────────

async function createTask(
  host: PluginServerHost,
  store: SchedulerStore,
  input: CreateTaskInput,
): Promise<{ task: TaskDTO }> {
  const agentId = input.agentId?.trim();
  if (!agentId) throw new Error('agentId 不能为空');
  if (!host.agents.get(agentId)) throw new Error(`agent 不存在：${agentId}`);
  const prompt = input.prompt?.trim();
  if (!prompt) throw new Error('prompt 不能为空');

  const scheduleKind: ScheduleKind = input.scheduleKind ?? 'cron';
  const sessionMode: SessionMode = input.sessionMode ?? 'new';
  const sessionId = await normalizeSessionBinding(host, agentId, sessionMode, input.sessionId);

  const nextAt = computeNextAt(
    { scheduleKind, cronExpr: input.cronExpr, timezone: input.timezone, at: input.at },
    Date.now(),
  );

  const task = store.insert({
    agentId,
    name: input.name?.trim() || defaultName(input),
    prompt,
    scheduleKind,
    cronExpr: scheduleKind === 'cron' ? (input.cronExpr ?? '').trim() : null,
    timezone: scheduleKind === 'cron' ? (input.timezone ?? '').trim() : null,
    at: scheduleKind === 'once' ? Number(input.at) : null,
    sessionMode,
    sessionId,
    enabled: true,
    nextAt,
    // 一次性任务跑一次就停（旧版同款：创建时把 max_runs 钉成 1）。
    maxRuns: scheduleKind === 'once' ? 1 : (input.maxRuns ?? null),
  });
  host.log('info', `created task ${task.id} (${task.scheduleKind})`);
  return { task };
}

async function updateTask(
  host: PluginServerHost,
  store: SchedulerStore,
  taskId: string,
  input: UpdateTaskInput,
): Promise<TaskDTO> {
  const task = store.get(taskId);
  if (!task) throw new Error(`任务不存在：${taskId}`);

  const patch: Record<string, unknown> = {};

  if (input.name !== undefined) patch.name = input.name.trim() || task.name;
  if (input.prompt !== undefined) {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('prompt 不能为空');
    patch.prompt = prompt;
  }

  // 会话绑定：传值 = 换绑；'' / null = 解绑（首次触发时创建）；切到 new = 自动清空。
  const nextMode: SessionMode = input.sessionMode ?? task.sessionMode;
  if (input.sessionMode !== undefined || input.sessionId !== undefined) {
    patch.session_mode = nextMode;
    patch.session_id = await normalizeSessionBinding(host, task.agentId, nextMode, input.sessionId, task.sessionId);
  }

  if (input.maxRuns !== undefined && task.scheduleKind !== 'once') patch.max_runs = input.maxRuns;

  if (input.enabled !== undefined && input.enabled !== task.enabled) {
    if (input.enabled) {
      if (task.maxRuns !== null && task.runsCount >= task.maxRuns) {
        throw new Error(`已达 max_runs 上限（${task.maxRuns}），先提高上限再启用`);
      }
      // 按 now 重算：否则过期 slot 会在启用瞬间补跑。
      patch.enabled = 1;
      patch.next_at = computeNextAt(
        { scheduleKind: task.scheduleKind, cronExpr: task.cronExpr ?? undefined, timezone: task.timezone ?? undefined, at: task.at ?? undefined },
        Date.now(),
      );
    } else {
      patch.enabled = 0;
      patch.next_at = null;
    }
  } else if (input.reschedule) {
    patch.next_at = computeNextAt(
      {
        scheduleKind: task.scheduleKind,
        cronExpr: (input.cronExpr ?? task.cronExpr) ?? undefined,
        timezone: (input.timezone ?? task.timezone) ?? undefined,
        at: input.at ?? task.at ?? undefined,
      },
      Date.now(),
    );
    if (input.cronExpr !== undefined) patch.cron_expr = input.cronExpr.trim();
    if (input.timezone !== undefined) patch.timezone = input.timezone.trim();
  }

  store.update(taskId, patch);
  return store.get(taskId)!;
}

async function normalizeSessionBinding(
  host: PluginServerHost,
  agentId: string,
  mode: SessionMode,
  sessionId: string | undefined,
  current?: string | null,
): Promise<string | null> {
  if (mode === 'new') {
    // 不静默丢弃：传了就报错，否则"两个人对写哪儿有不同理解"。
    if (sessionId) throw new Error('sessionMode=new 时不能指定 sessionId');
    return null;
  }
  if (sessionId === undefined) return current ?? null;
  if (!sessionId) return null;
  const session = await host.sessions.get(sessionId);
  if (!session) throw new Error(`会话不存在：${sessionId}`);
  if (session.agentId && session.agentId !== agentId) throw new Error(`会话 ${sessionId} 不属于该 agent`);
  return sessionId;
}

function defaultName(input: CreateTaskInput): string {
  if (input.scheduleKind === 'once' && input.at) {
    return `一次性任务 ${new Date(Number(input.at)).toISOString().slice(0, 16).replace('T', ' ')}`;
  }
  return `定时任务 ${input.cronExpr ?? ''}`.trim();
}

// ────────────────────────────── 投递 ──────────────────────────────

interface DispatchResult {
  status: 'delivered' | 'skipped' | 'missed' | 'failed';
  runId?: string;
  sessionId?: string;
  reason?: string;
}

async function dispatch(
  host: PluginServerHost,
  store: SchedulerStore,
  taskId: string,
  triggeredBy: RunTrigger,
): Promise<DispatchResult> {
  const task = store.get(taskId);
  if (!task) return { status: 'skipped', reason: 'task-not-found' };

  if (!task.enabled) {
    const runId = store.createRun({ taskId, status: 'skipped', triggeredBy, reason: 'disabled' });
    return { status: 'skipped', runId, reason: 'disabled' };
  }

  // overlap：只看 30 分钟窗口内未收尾的 run（更老的已经在启动收敛时标成 stale）。
  if (store.hasOpenRun(taskId, Date.now() - OVERLAP_WINDOW_MS)) {
    const runId = store.createRun({ taskId, status: 'skipped', triggeredBy, reason: 'overlap' });
    host.log('info', `task ${taskId} skipped: overlap`);
    return { status: 'skipped', runId, reason: 'overlap' };
  }

  const runId = store.createRun({ taskId, status: 'failed', triggeredBy, finished: false });
  try {
    // ① 取会话 —— 绑定目标在投递前**再校验一次**：`ensure` 对陌生 id 会抛错，
    //    所以"会话被删 / 换了 agent"会变成一条 failed run，而不是静默写到别处。
    const session = await host.sessions.ensure({
      agentId: task.agentId,
      ...(task.sessionMode === 'reuse' && task.sessionId ? { sessionId: task.sessionId } : {}),
      ...(task.sessionMode === 'reuse' && !task.sessionId ? { title: `[${task.name}]` } : {}),
    });

    // ② 投递信封（文本由内核构造）。返回即"送到"，不等 agent 跑完。
    await host.sessions.systemEvent({
      sessionId: session.sessionId,
      kind: 'trigger',
      source: task.scheduleKind,
      name: task.name,
      run: runId,
      instruction: task.prompt,
    });

    store.finishRun(runId, { status: 'delivered', sessionId: session.sessionId });

    const runsCount = task.runsCount + 1;
    const patch: Record<string, unknown> = { runs_count: runsCount, last_fired_at: Date.now() };
    // reuse 首次触发后回填绑定，此后固定复用同一个会话。
    if (task.sessionMode === 'reuse' && !task.sessionId) patch.session_id = session.sessionId;
    // max_runs 收敛（once 就是 max_runs=1）。
    if (task.maxRuns !== null && runsCount >= task.maxRuns) {
      patch.enabled = 0;
      patch.next_at = null;
      host.log('info', `task ${taskId} reached max_runs (${task.maxRuns}) — disabled`);
    }
    store.update(taskId, patch);

    host.log('info', `task ${taskId} delivered → session ${session.sessionId} (${triggeredBy})`);
    return { status: 'delivered', runId, sessionId: session.sessionId };
  } catch (err) {
    const reason = messageOf(err);
    store.finishRun(runId, { status: 'failed', reason });
    host.log('warn', `task ${taskId} delivery failed: ${reason}`);
    // 事件总线：通知插件订阅后落一行收件箱；没装通知插件就只有任务页标红。
    host.bus.publish('scheduler.run.failed', {
      taskId,
      runId,
      name: task.name,
      agentId: task.agentId,
      reason,
      actionUrl: `/scheduler/${taskId}`,
    });
    return { status: 'failed', runId, reason };
  }
}

// ────────────────────────────── 调度器 ──────────────────────────────

function createScheduler(host: PluginServerHost, store: SchedulerStore) {
  let timer: NodeJS.Timeout | null = null;
  let disposed = false;
  /** Node 的 setTimeout 上限（~24.8 天）；更远的 slot 只能分段等。 */
  const MAX_DELAY = 2 ** 31 - 1;

  function clear(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function arm(): void {
    if (disposed) return;
    clear();
    const nextAt = store.earliestNextAt();
    if (nextAt === null) return;
    const delay = Math.max(0, Math.min(nextAt - Date.now(), MAX_DELAY));
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delay);
    // 调度器 timer 不该拖住进程退出。
    timer.unref?.();
  }

  async function tick(): Promise<void> {
    if (disposed) return;
    try {
      const now = Date.now();
      for (const task of store.due(now)) {
        if (disposed) return;
        // 抢占：先推进 slot，抢不到就说明别人已经在处理这个 slot。
        const nextSlot = task.scheduleKind === 'cron'
          ? nextCronTime(task.cronExpr ?? '', task.timezone ?? 'UTC', now)
          : null;
        if (!store.claimNextAt(task.id, task.nextAt, nextSlot)) continue;
        const result = await dispatch(host, store, task.id, 'schedule');
        if (result.status === 'delivered' || result.status === 'failed') {
          host.log('debug', `tick ${task.id} → ${result.status}`);
        }
      }
    } catch (err) {
      host.log('error', `scheduler tick failed: ${messageOf(err)}`);
    } finally {
      if (!disposed) arm();
    }
  }

  return {
    start: arm,
    rearm: arm,
    tick,
    dispose() {
      disposed = true;
      clear();
    },
  };
}

/** 启动收敛：停机期间跨过的 slot 只写一条 missed，`next_at` 推进到第一个未来 slot，不补跑。 */
function catchUpMissed(host: PluginServerHost, store: SchedulerStore): void {
  const now = Date.now();
  for (const task of store.due(now)) {
    let nextAt: number | null = null;
    let missed = 0;
    if (task.scheduleKind === 'cron') {
      let cursor = task.nextAt ?? now;
      nextAt = nextCronTime(task.cronExpr ?? '', task.timezone ?? 'UTC', cursor);
      while (nextAt !== null && nextAt <= now && missed < MAX_CATCHUP_SLOTS) {
        missed += 1;
        cursor = nextAt;
        nextAt = nextCronTime(task.cronExpr ?? '', task.timezone ?? 'UTC', cursor);
      }
      missed += 1; // 当前这个已到点的 slot 本身也算错过
    } else {
      missed = 1;
      nextAt = null; // 一次性任务的 slot 过了就是过了
    }
    store.claimNextAt(task.id, task.nextAt, nextAt);
    store.createRun({ taskId: task.id, status: 'missed', triggeredBy: 'schedule', reason: `missed ${missed} slot(s) while stopped` });
    // 一次性任务错过就停用（否则它永远 enabled 却 next_at=null）。
    if (task.scheduleKind === 'once') store.update(task.id, { enabled: 0 });
    host.log('info', `task ${task.id}: ${missed} slot(s) missed while stopped — not replayed`);
  }
}

// ────────────────────────────── 小工具 ──────────────────────────────

function parseBody(body: string): Record<string, unknown> {
  if (!body.trim()) return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
