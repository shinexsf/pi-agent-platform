/**
 * Notification inbox. Read-only-ish: list, mark
 * read. Creating a notification is NOT an HTTP operation — only `notifier.notify()`
 * (agent tool / server failure) writes rows.
 */

import { Hono } from 'hono';
import type { NotificationRepo } from '../repos/notification.repo.js';
import type { NotificationSeverity } from '@pi-agent-platform/shared-types';

const SEVERITIES: NotificationSeverity[] = ['info', 'warning', 'error'];

export function createNotificationsRouter(repo: NotificationRepo) {
  const router = new Hono();

  // GET /api/notifications?unread=1&severity=error&limit=50
  router.get('/', (c) => {
    const unread = c.req.query('unread') === '1';
    const rawSeverity = c.req.query('severity');
    const severity = SEVERITIES.find((s) => s === rawSeverity);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
    const items = repo.list({ unread, severity, limit });
    return c.json({ items, unreadCount: repo.unreadCount() });
  });

  // POST /api/notifications/:id/read
  router.post('/:id/read', (c) => {
    const id = c.req.param('id');
    if (!repo.markRead(id)) return c.json({ error: 'notification not found' }, 404);
    return c.json({ ok: true, unreadCount: repo.unreadCount() });
  });

  // POST /api/notifications/read-all
  router.post('/read-all', (c) => {
    const changed = repo.markAllRead();
    return c.json({ ok: true, changed, unreadCount: repo.unreadCount() });
  });

  return router;
}
