const OVERLAP_WINDOW_MS = 30 * 60 * 1e3;
const DDL = `
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('cron','once')),
    cron_expr TEXT,
    timezone TEXT,
    at INTEGER,
    session_mode TEXT NOT NULL CHECK (session_mode IN ('new','reuse')),
    session_id TEXT,
    busy_policy TEXT NOT NULL DEFAULT 'followUp' CHECK (busy_policy IN ('followUp','steer','skip')),
    enabled INTEGER NOT NULL DEFAULT 1,
    next_at INTEGER,
    max_runs INTEGER,
    runs_count INTEGER NOT NULL DEFAULT 0,
    last_fired_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sched_next ON scheduled_tasks(enabled, next_at);
  CREATE INDEX IF NOT EXISTS idx_sched_agent ON scheduled_tasks(agent_id);

  CREATE TABLE IF NOT EXISTS scheduled_task_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('delivered','skipped','missed','failed')),
    reason TEXT,
    triggered_by TEXT NOT NULL CHECK (triggered_by IN ('schedule','manual','plugin')),
    session_id TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sched_runs_task ON scheduled_task_runs(task_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_sched_runs_open ON scheduled_task_runs(finished_at);
`;
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
function toTaskDTO(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    prompt: row.prompt,
    scheduleKind: row.schedule_kind,
    cronExpr: row.cron_expr,
    timezone: row.timezone,
    at: row.at,
    sessionMode: row.session_mode,
    sessionId: row.session_id,
    busyPolicy: row.busy_policy,
    enabled: row.enabled === 1,
    nextAt: row.next_at,
    maxRuns: row.max_runs,
    runsCount: row.runs_count,
    lastFiredAt: row.last_fired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
const toRunDTO = (row) => ({
  id: row.id,
  taskId: row.task_id,
  status: row.status,
  reason: row.reason,
  triggeredBy: row.triggered_by,
  sessionId: row.session_id,
  startedAt: row.started_at,
  finishedAt: row.finished_at
});
function createStore(db) {
  return {
    // ── 任务 ──
    get(id) {
      const row = db.query("SELECT * FROM scheduled_tasks WHERE id = ?", [id])[0];
      return row ? toTaskDTO(row) : void 0;
    },
    list(filter = {}) {
      const where = [];
      const params = [];
      if (filter.agentId) {
        where.push("agent_id = ?");
        params.push(filter.agentId);
      }
      if (!filter.includeDisabled) where.push("enabled = 1");
      const sql = `SELECT * FROM scheduled_tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`;
      return db.query(sql, params).map(toTaskDTO);
    },
    /** 到点候选：`enabled = 1 AND next_at <= now`。调度器只扫这条索引。 */
    due(now) {
      return db.query("SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at", [now]).map(toTaskDTO);
    },
    /** 最近的下一个计划时刻（全表）；没有则 `null`。 */
    earliestNextAt() {
      const row = db.query(
        "SELECT MIN(next_at) AS next_at FROM scheduled_tasks WHERE enabled = 1 AND next_at IS NOT NULL"
      )[0];
      return row?.next_at ?? null;
    },
    insert(input) {
      const now = Date.now();
      const id = newId("task");
      db.query(
        `INSERT INTO scheduled_tasks
         (id, agent_id, name, prompt, schedule_kind, cron_expr, timezone, at, session_mode, session_id,
          busy_policy, enabled, next_at, max_runs, runs_count, last_fired_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
        [
          id,
          input.agentId,
          input.name,
          input.prompt,
          input.scheduleKind,
          input.cronExpr,
          input.timezone,
          input.at,
          input.sessionMode,
          input.sessionId,
          input.busyPolicy,
          input.enabled ? 1 : 0,
          input.nextAt,
          input.maxRuns,
          now,
          now
        ]
      );
      return this.get(id);
    },
    update(id, patch) {
      const cols = Object.keys(patch);
      if (cols.length === 0) return;
      db.query(
        `UPDATE scheduled_tasks SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        [...cols.map((c) => patch[c]), Date.now(), id]
      );
    },
    /**
     * 抢占 slot：只有"期望值仍是它"时才推进。
     *
     * 返回 true = 抢到（本次 tick 负责投递）；false = 别人先推进了（静默跳过）。
     * 这是整个调度器**唯一**的互斥点。
     *
     * 为什么能这么判：`host.db.query` 对写语句不返回 changes（一个 query 口的代价），
     * 而 `UPDATE … WHERE next_at IS ?` 与随后的读回**都在同一个同步调用里**
     * （better-sqlite3 同步 + Node 单线程），中间不可能有别的写入插进来 ——
     * 所以"读回值等于目标值"就等价于"这次更新生效了"。
     */
    claimNextAt(id, expected, next) {
      db.query("UPDATE scheduled_tasks SET next_at = ?, updated_at = ? WHERE id = ? AND next_at IS ?", [
        next,
        Date.now(),
        id,
        expected
      ]);
      const row = db.query("SELECT next_at FROM scheduled_tasks WHERE id = ?", [id])[0];
      return row ? row.next_at === next : false;
    },
    remove(id) {
      db.query("DELETE FROM scheduled_task_runs WHERE task_id = ?", [id]);
      db.query("DELETE FROM scheduled_tasks WHERE id = ?", [id]);
    },
    // ── runs ──
    /**
     * 落一条 run。
     *
     * `finished: true` 用于"根本没有投递动作"的终态（skipped / missed）——
     * 这类行必须立刻收尾，否则会被 overlap 守卫当成"上一轮还在跑"。
     */
    createRun(input) {
      const id = newId("run");
      const now = Date.now();
      db.query(
        `INSERT INTO scheduled_task_runs (id, task_id, status, reason, triggered_by, session_id, started_at, finished_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.taskId,
          input.status,
          input.reason ?? null,
          input.triggeredBy,
          input.sessionId ?? null,
          now,
          input.finished === false ? null : now,
          now
        ]
      );
      return id;
    },
    finishRun(id, patch) {
      db.query("UPDATE scheduled_task_runs SET status = ?, reason = ?, session_id = COALESCE(?, session_id), finished_at = ? WHERE id = ?", [
        patch.status,
        patch.reason ?? null,
        patch.sessionId ?? null,
        Date.now(),
        id
      ]);
    },
    /** 窗口内是否还有未收尾的 run（overlap 守卫）。 */
    hasOpenRun(taskId, since) {
      const row = db.query(
        "SELECT COUNT(*) AS n FROM scheduled_task_runs WHERE task_id = ? AND finished_at IS NULL AND started_at >= ?",
        [taskId, since]
      )[0];
      return (row?.n ?? 0) > 0;
    },
    listRuns(taskId, limit = 50) {
      return db.query("SELECT * FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?", [taskId, limit]).map(toRunDTO);
    },
    /** 启动时把僵尸 run（进程崩溃留下的未收尾行）标掉，否则 overlap 会永久卡死。 */
    finalizeStaleRuns() {
      const rows = db.query("SELECT id FROM scheduled_task_runs WHERE finished_at IS NULL");
      for (const r of rows) {
        db.query("UPDATE scheduled_task_runs SET status = ?, reason = ?, finished_at = ? WHERE id = ?", [
          "failed",
          "stale",
          Date.now(),
          r.id
        ]);
      }
      return rows.length;
    }
  };
}
export {
  DDL,
  OVERLAP_WINDOW_MS,
  createStore,
  toTaskDTO
};
