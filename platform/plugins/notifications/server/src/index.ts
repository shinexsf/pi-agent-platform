/**
 * 系统通知收件箱（bundled 插件）。
 *
 * 归属：这个子系统以前长在 server 入口里（`services/notifier.ts` + `repos/notification.repo.ts`
 * + `routes/notifications.ts` + app.ts 里一段 `registerService`）。按"做减法"的判据——
 * **把它 enabled:false 之后平台还能建 agent、开会话、聊完一轮**——它是典型插件：
 * 关掉它，只是收件箱空了，别的一切照常。
 *
 * 职责边界（与 v1 一致，一个字没改）：
 * - 只有两个写入方：agent 的 `postNotification` 工具（反向方法）与平台内部失败（直接写）
 * - `notify` 只落库：没有投递层、没有重试、没有合并去重、不对外发 HTTP
 * - `read_at` 只表示"用户读过"，平台不提供消费游标
 *
 * 端点在 `/api/p/notifications/` 下（插件前缀由平台加），前端 `useNotifications` 已改指这里。
 */

import type { PluginServerHost } from '@pi-agent-platform/plugin-types';

/** 单条通知（与 v1 的 `NotificationDTO` 同形）。 */
export interface NotificationDTO {
  id: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  body: string;
  source: string;
  sourceId?: string | null;
  actionUrl?: string | null;
  readAt?: number | null;
  createdAt: number;
}

interface NotificationRow {
  id: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  body: string;
  source: string;
  source_id: string | null;
  action_url: string | null;
  read_at: number | null;
  created_at: number;
}

const SEVERITIES = ['info', 'warning', 'error'] as const;

function toDTO(row: NotificationRow): NotificationDTO {
  return {
    id: row.id,
    severity: row.severity,
    title: row.title,
    body: row.body,
    source: row.source,
    sourceId: row.source_id,
    actionUrl: row.action_url,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

/** 失败事件的统一形状（发布方约定见 `failure-notifications` 规格）。 */
interface FailurePayload {
  /** 发布方插件 id（= topic 的前缀）。 */
  source?: string;
  taskId?: string;
  runId?: string;
  hookId?: string;
  deliveryId?: string;
  name?: string;
  agentId?: string;
  reason?: string;
  actionUrl?: string;
}

export default {
  init(host: PluginServerHost) {
    // R4：自己的表自己建（幂等；平台记台账，卸载时提示"留下的表"）
    host.db.migrate(
      'notifications',
      `
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT,
        action_url TEXT,
        read_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
      CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at);
      `,
    );

    const unreadCount = (): number =>
      host.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL')[0]?.n ?? 0;

    // R1 正式页面：`nav: false` —— 只登记路由，不占导航项。
    // 入口从顶栏铃铛面板里的「查看全部」进（避免导航里出现两个「通知」）。
    host.ui.page({ path: '/notifications', label: '通知', icon: 'bell', component: 'page', nav: false });

    // R11 顶栏动作：铃铛 + 未读角标，点开就地展开面板（不跳页、不占导航）。
    // 平台原本的顶栏铃铛与 `/notifications` 页面已删除 —— 通知入口现在只有这一个。
    host.ui.headerAction({
      id: 'inbox',
      icon: 'bell',
      title: '通知',
      component: 'panel',
      order: 10,
      badge: { endpoint: '/unread-count' },
    });

    // R2：收件箱端点（平台加前缀 /api/p/notifications）
    host.http.route({
      method: 'GET',
      path: '/',
      handler: (req) => {
        const unread = req.query.unread === '1';
        const severity = SEVERITIES.find((s) => s === req.query.severity);
        const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
        const where: string[] = [];
        const params: unknown[] = [];
        if (unread) where.push('read_at IS NULL');
        if (severity) {
          where.push('severity = ?');
          params.push(severity);
        }
        const sql = `SELECT * FROM notifications ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
        const rows = host.db.query<NotificationRow>(sql, [...params, limit]);
        return { json: { items: rows.map(toDTO), unreadCount: unreadCount() } };
      },
    });

    host.http.route({
      method: 'POST',
      path: '/:id/read',
      handler: (req) => {
        const id = req.params.id ?? '';
        const changed = host.db.query('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL', [Date.now(), id]);
        void changed;
        const row = host.db.query<NotificationRow>('SELECT * FROM notifications WHERE id = ?', [id])[0];
        if (!row) return { status: 404, json: { error: 'notification not found' } };
        return { json: { ok: true, unreadCount: unreadCount() } };
      },
    });

    // 顶栏角标：宿主定期 GET，返回 { count }
    host.http.route({
      method: 'GET',
      path: '/unread-count',
      handler: () => ({ json: { count: unreadCount() } }),
    });

    host.http.route({
      method: 'POST',
      path: '/read-all',
      handler: () => {
        const before = unreadCount();
        host.db.query('UPDATE notifications SET read_at = ? WHERE read_at IS NULL', [Date.now()]);
        return { json: { ok: true, changed: before, unreadCount: unreadCount() } };
      },
    });

    /** 落一行通知（反向方法 / 总线订阅共用；深链由平台或发布方给）。 */
    function insert(input: {
      title: string;
      body?: string;
      severity?: 'info' | 'warning' | 'error';
      source: string;
      sourceId?: string | null;
      actionUrl?: string | null;
    }): string {
      const id = `ntf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      host.db.query(
        'INSERT INTO notifications (id, severity, title, body, source, source_id, action_url, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)',
        [
          id,
          input.severity ?? 'info',
          input.title.slice(0, 200),
          (input.body ?? '').slice(0, 4000),
          input.source,
          input.sourceId ?? null,
          input.actionUrl ?? null,
          Date.now(),
        ],
      );
      return id;
    }

    // R3：反向方法（worker 的 `postNotification` 工具调 `plugin.notifications.post`）
    host.methods.handle('post', (params, ctx) => {
      const p = (params ?? {}) as { title?: string; body?: string; severity?: 'info' | 'warning' | 'error' };
      const title = (p.title ?? '').trim();
      const body = (p.body ?? '').trim();
      if (!title && !body) throw new Error('postNotification: title/body required');
      const id = insert({
        title,
        body,
        severity: p.severity ?? 'info',
        source: 'agent',
        sourceId: ctx.sessionId || null,
        // 深链由平台拼，调用方（模型）给不了
        actionUrl: ctx.sessionId ? `/chat/${ctx.sessionId}` : null,
      });
      return { id, unreadCount: unreadCount() };
    });

    // ── 总线订阅：别的插件的失败事件 → 收件箱 ──
    //
    // 发布方（scheduler / webhook）**不认识通知插件**，它们只 publish；
    // 这里订不订阅是自由的 —— 没装通知插件时那些 publish 静默消失，
    // 失败信息仍然在各自的台账里（`scheduled_task_runs` / `webhook_deliveries`）。
    const FAILURE_TOPICS: Array<{ topic: string; label: (p: FailurePayload) => string }> = [
      { topic: 'scheduler.run.failed', label: (p) => `定时任务「${p.name}」投递失败` },
      { topic: 'webhook.delivery.failed', label: (p) => `Webhook「${p.name}」投递失败` },
    ];

    for (const { topic, label } of FAILURE_TOPICS) {
      const off = host.bus.subscribe(topic, (raw) => {
        const p = (raw ?? {}) as FailurePayload;
        insert({
          title: label(p),
          body: p.reason ?? '',
          severity: 'error',
          source: p.source ?? topic.split('.')[0] ?? 'plugin',
          sourceId: p.taskId ?? p.hookId ?? null,
          actionUrl: p.actionUrl ?? null,
        });
      });
      // disposer 进插件账本（卸载归零由装载器保证），这里只是显式声明意图。
      void off;
    }

    host.log('info', 'notifications plugin ready');
  },
};
