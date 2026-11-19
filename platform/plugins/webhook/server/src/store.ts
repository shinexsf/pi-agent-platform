/**
 * 数据访问层 —— 表结构 + 查询。
 *
 * 表规则：插件自己的表自己建（`host.db.migrate`），登记进 `plugin_migrations` 台账；
 * 卸载时平台只告诉用户"这些表还留着"，**不自动删**。
 */

import { randomBytes } from 'node:crypto';
import type { PluginDbApi } from '@pi-agent-platform/plugin-types';
import type { DeliveryDTO, DeliveryRow, DeliveryStatus, DeliveryTrigger, HookDTO, HookRow } from './types.js';

/** 幂等窗口：同一 hook + 同一 key 在 24h 内只执行一次。 */
export const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** body 上限（超出截断，台账记原始字节数）。 */
export const MAX_BODY_BYTES = 64 * 1024;
/** 上一轮没收尾的投递超过这个窗口就不再算"进行中"（进程崩溃残留）。 */
export const STALE_DELIVERY_MS = 10 * 60 * 1000;

export const DDL = `
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

/** secret 与路径 id 绑定：32 字符 base64url（24 字节熵）。 */
export function generateSecret(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * 常量时间近似比较：长度先比，再逐字符异或累加（不提前返回）。
 *
 * 不用 `crypto.timingSafeEqual`：它要求等长，长度不等会**抛错**，
 * 于是"用错长度探测"会变成异常路径而不是统一的 401。
 */
export function secretsMatch(expected: string, provided: string): boolean {
  if (!expected || !provided || expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

const newId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export function toHookDTO(row: HookRow): HookDTO {
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
    updatedAt: row.updated_at,
  };
}

const toDeliveryDTO = (row: DeliveryRow): DeliveryDTO => ({
  id: row.id,
  hookId: row.hook_id,
  status: row.status,
  reason: row.reason,
  triggeredBy: row.triggered_by,
  idempotencyKey: row.idempotency_key,
  payloadBytes: row.payload_bytes,
  sessionId: row.session_id,
  receivedAt: row.received_at,
  finishedAt: row.finished_at,
});

export function createStore(db: PluginDbApi) {
  return {
    // ── hooks ──
    get(id: string): HookDTO | undefined {
      const row = db.query<HookRow>('SELECT * FROM webhook_hooks WHERE id = ?', [id])[0];
      return row ? toHookDTO(row) : undefined;
    },

    list(filter: { agentId?: string; includeDisabled?: boolean } = {}): HookDTO[] {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.agentId) {
        where.push('agent_id = ?');
        params.push(filter.agentId);
      }
      if (!filter.includeDisabled) where.push('enabled = 1');
      const sql = `SELECT * FROM webhook_hooks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`;
      return db.query<HookRow>(sql, params).map(toHookDTO);
    },

    insert(input: Omit<HookDTO, 'id' | 'createdAt' | 'updatedAt' | 'deliveriesCount' | 'lastDeliveredAt'>): HookDTO {
      const now = Date.now();
      const id = newId('hook');
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
          now,
        ],
      );
      return this.get(id)!;
    },

    update(id: string, patch: Record<string, unknown>): void {
      const cols = Object.keys(patch);
      if (cols.length === 0) return;
      db.query(
        `UPDATE webhook_hooks SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        [...cols.map((c) => patch[c]), Date.now(), id],
      );
    },

    remove(id: string): void {
      // hook 没了，投递记录也一起删：外部事件的过程记录不构成跨 hook 的审计数据。
      db.query('DELETE FROM webhook_deliveries WHERE hook_id = ?', [id]);
      db.query('DELETE FROM webhook_hooks WHERE id = ?', [id]);
    },

    // ── deliveries ──
    /** 18 位 RFC4122-ish id：随机性只用于排序友好，不参与鉴权。 */
    createDelivery(input: {
      hookId: string;
      status: DeliveryStatus;
      triggeredBy: DeliveryTrigger;
      idempotencyKey?: string | null;
      payloadBytes?: number | null;
      reason?: string;
      sessionId?: string;
      finished?: boolean;
    }): string {
      const id = newId('dlv');
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
          now,
        ],
      );
      return id;
    },

    finishDelivery(
      id: string,
      patch: { status: DeliveryStatus; reason?: string; sessionId?: string },
    ): void {
      db.query('UPDATE webhook_deliveries SET status = ?, reason = ?, session_id = ?, finished_at = ? WHERE id = ?', [
        patch.status,
        patch.reason ?? null,
        patch.sessionId ?? null,
        Date.now(),
        id,
      ]);
    },

    /** 同 hook + 同 key 在窗口内是否已有投递（**只看成功送出的**，被跳过的不占坑）。 */
    hasRecentIdempotencyKey(hookId: string, key: string, since: number): boolean {
      const row = db.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM webhook_deliveries
         WHERE hook_id = ? AND idempotency_key = ? AND received_at >= ? AND status = 'delivered'`,
        [hookId, key, since],
      )[0];
      return (row?.n ?? 0) > 0;
    },

    listDeliveries(hookId: string, limit = 50): DeliveryDTO[] {
      const capped = Math.min(Math.max(limit, 1), 200);
      return db
        .query<DeliveryRow>('SELECT * FROM webhook_deliveries WHERE hook_id = ? ORDER BY received_at DESC LIMIT ?', [
          hookId,
          capped,
        ])
        .map(toDeliveryDTO);
    },

    /** 成功投递后回写计数（幂等：失败/跳过不计数）。 */
    markDelivered(hookId: string): void {
      db.query(
        'UPDATE webhook_hooks SET deliveries_count = deliveries_count + 1, last_delivered_at = ?, updated_at = ? WHERE id = ?',
        [Date.now(), Date.now(), hookId],
      );
    },

    /** 启动收敛：进程崩溃留下的未收尾投递（`finished_at IS NULL`）→ `failed/stale`。 */
    finalizeStaleDeliveries(olderThan = STALE_DELIVERY_MS): number {
      const cutoff = Date.now() - olderThan;
      const rows = db.query<{ id: string }>(
        'SELECT id FROM webhook_deliveries WHERE finished_at IS NULL AND received_at < ?',
        [cutoff],
      );
      for (const row of rows) {
        db.query('UPDATE webhook_deliveries SET status = ?, reason = ?, finished_at = ? WHERE id = ?', [
          'failed',
          'stale',
          Date.now(),
          row.id,
        ]);
      }
      return rows.length;
    },
  };
}

export type WebhookStore = ReturnType<typeof createStore>;
