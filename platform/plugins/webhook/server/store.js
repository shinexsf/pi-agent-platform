import { randomBytes } from "node:crypto";
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1e3;
const MAX_BODY_BYTES = 64 * 1024;
const STALE_DELIVERY_MS = 10 * 60 * 1e3;
const DDL = `
  CREATE TABLE IF NOT EXISTS webhook_hooks (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    session_mode TEXT NOT NULL CHECK (session_mode IN ('new','reuse')),
    session_id TEXT,
    busy_policy TEXT NOT NULL DEFAULT 'followUp' CHECK (busy_policy IN ('followUp','steer','skip')),
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    deliveries_count INTEGER NOT NULL DEFAULT 0,
    last_delivered_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_agent ON webhook_hooks(agent_id);

  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,
    hook_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('delivered','skipped','failed')),
    reason TEXT,
    triggered_by TEXT NOT NULL CHECK (triggered_by IN ('http','manual','plugin')),
    idempotency_key TEXT,
    payload_bytes INTEGER,
    session_id TEXT,
    received_at INTEGER NOT NULL,
    finished_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook ON webhook_deliveries(hook_id, received_at);
  CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_idem ON webhook_deliveries(hook_id, idempotency_key, received_at);
`;
function generateSecret() {
  return randomBytes(24).toString("base64url");
}
function secretsMatch(expected, provided) {
  if (!expected || !provided || expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
function toHookDTO(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    prompt: row.prompt,
    sessionMode: row.session_mode,
    sessionId: row.session_id,
    busyPolicy: row.busy_policy,
    secret: row.secret,
    enabled: row.enabled === 1,
    deliveriesCount: row.deliveries_count,
    lastDeliveredAt: row.last_delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
const toDeliveryDTO = (row) => ({
  id: row.id,
  hookId: row.hook_id,
  status: row.status,
  reason: row.reason,
  triggeredBy: row.triggered_by,
  idempotencyKey: row.idempotency_key,
  payloadBytes: row.payload_bytes,
  sessionId: row.session_id,
  receivedAt: row.received_at,
  finishedAt: row.finished_at
});
function createStore(db) {
  return {
    // ── hooks ──
    get(id) {
      const row = db.query("SELECT * FROM webhook_hooks WHERE id = ?", [id])[0];
      return row ? toHookDTO(row) : void 0;
    },
    list(filter = {}) {
      const where = [];
      const params = [];
      if (filter.agentId) {
        where.push("agent_id = ?");
        params.push(filter.agentId);
      }
      if (!filter.includeDisabled) where.push("enabled = 1");
      const sql = `SELECT * FROM webhook_hooks ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`;
      return db.query(sql, params).map(toHookDTO);
    },
    insert(input) {
      const now = Date.now();
      const id = newId("hook");
      db.query(
        `INSERT INTO webhook_hooks
         (id, agent_id, name, prompt, session_mode, session_id, busy_policy, secret, enabled,
          deliveries_count, last_delivered_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
        [
          id,
          input.agentId,
          input.name,
          input.prompt,
          input.sessionMode,
          input.sessionId,
          input.busyPolicy,
          input.secret,
          input.enabled ? 1 : 0,
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
        `UPDATE webhook_hooks SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        [...cols.map((c) => patch[c]), Date.now(), id]
      );
    },
    remove(id) {
      db.query("DELETE FROM webhook_deliveries WHERE hook_id = ?", [id]);
      db.query("DELETE FROM webhook_hooks WHERE id = ?", [id]);
    },
    // ── deliveries ──
    /** 18 位 RFC4122-ish id：随机性只用于排序友好，不参与鉴权。 */
    createDelivery(input) {
      const id = newId("dlv");
      const now = Date.now();
      db.query(
        `INSERT INTO webhook_deliveries
         (id, hook_id, status, reason, triggered_by, idempotency_key, payload_bytes, session_id, received_at, finished_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          input.hookId,
          input.status,
          input.reason ?? null,
          input.triggeredBy,
          input.idempotencyKey ?? null,
          input.payloadBytes ?? null,
          input.sessionId ?? null,
          now,
          input.finished === false ? null : now,
          now
        ]
      );
      return id;
    },
    finishDelivery(id, patch) {
      db.query("UPDATE webhook_deliveries SET status = ?, reason = ?, session_id = ?, finished_at = ? WHERE id = ?", [
        patch.status,
        patch.reason ?? null,
        patch.sessionId ?? null,
        Date.now(),
        id
      ]);
    },
    /** 同 hook + 同 key 在窗口内是否已有投递（**只看成功送出的**，被跳过的不占坑）。 */
    hasRecentIdempotencyKey(hookId, key, since) {
      const row = db.query(
        `SELECT COUNT(*) AS n FROM webhook_deliveries
         WHERE hook_id = ? AND idempotency_key = ? AND received_at >= ? AND status = 'delivered'`,
        [hookId, key, since]
      )[0];
      return (row?.n ?? 0) > 0;
    },
    listDeliveries(hookId, limit = 50) {
      const capped = Math.min(Math.max(limit, 1), 200);
      return db.query("SELECT * FROM webhook_deliveries WHERE hook_id = ? ORDER BY received_at DESC LIMIT ?", [
        hookId,
        capped
      ]).map(toDeliveryDTO);
    },
    /** 成功投递后回写计数（幂等：失败/跳过不计数）。 */
    markDelivered(hookId) {
      db.query(
        "UPDATE webhook_hooks SET deliveries_count = deliveries_count + 1, last_delivered_at = ?, updated_at = ? WHERE id = ?",
        [Date.now(), Date.now(), hookId]
      );
    },
    /** 启动收敛：进程崩溃留下的未收尾投递（`finished_at IS NULL`）→ `failed/stale`。 */
    finalizeStaleDeliveries(olderThan = STALE_DELIVERY_MS) {
      const cutoff = Date.now() - olderThan;
      const rows = db.query(
        "SELECT id FROM webhook_deliveries WHERE finished_at IS NULL AND received_at < ?",
        [cutoff]
      );
      for (const row of rows) {
        db.query("UPDATE webhook_deliveries SET status = ?, reason = ?, finished_at = ? WHERE id = ?", [
          "failed",
          "stale",
          Date.now(),
          row.id
        ]);
      }
      return rows.length;
    }
  };
}
export {
  DDL,
  IDEMPOTENCY_WINDOW_MS,
  MAX_BODY_BYTES,
  STALE_DELIVERY_MS,
  createStore,
  generateSecret,
  secretsMatch,
  toHookDTO
};
