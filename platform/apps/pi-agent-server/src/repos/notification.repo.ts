/**
 * Notification repository — the system notification table.
 *
 * Notifications are an inbox: write once, read N times, never edited.
 * No delivery state: the platform does not push anywhere (see services/notifier.ts).
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DB } from '../db/init.js';
import { notifications } from '../db/schema.js';
import type { NotificationDTO, NotificationSeverity } from '@pi-agent-platform/shared-types';

type Row = typeof notifications.$inferSelect;

function rowToDTO(row: Row): NotificationDTO {
  return {
    id: row.id,
    severity: row.severity as NotificationSeverity,
    title: row.title,
    body: row.body,
    source: row.source,
    sourceId: row.sourceId,
    actionUrl: row.actionUrl,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

export function createNotificationRepo(db: DB) {
  return {
    create(input: {
      severity: NotificationSeverity;
      title: string;
      body: string;
      source: string;
      sourceId?: string | null;
      actionUrl?: string | null;
    }): NotificationDTO {
      const id = randomUUID();
      db.insert(notifications)
        .values({
          id,
          severity: input.severity,
          title: input.title,
          body: input.body,
          source: input.source,
          sourceId: input.sourceId ?? null,
          actionUrl: input.actionUrl ?? null,
          readAt: null,
          createdAt: Date.now(),
        })
        .run();
      return rowToDTO(this.getRow(id)!);
    },

    getRow(id: string): Row | undefined {
      return db.select().from(notifications).where(eq(notifications.id, id)).get();
    },

    get(id: string): NotificationDTO | undefined {
      const row = this.getRow(id);
      return row ? rowToDTO(row) : undefined;
    },

    list(filter?: { unread?: boolean; severity?: NotificationSeverity; limit?: number }): NotificationDTO[] {
      const conditions = [];
      if (filter?.unread) conditions.push(isNull(notifications.readAt));
      if (filter?.severity) conditions.push(eq(notifications.severity, filter.severity));
      const rows =
        conditions.length > 0
          ? db
              .select()
              .from(notifications)
              .where(and(...conditions))
              .orderBy(desc(notifications.createdAt))
              .limit(filter?.limit ?? 100)
              .all()
          : db
              .select()
              .from(notifications)
              .orderBy(desc(notifications.createdAt))
              .limit(filter?.limit ?? 100)
              .all();
      return rows.map(rowToDTO);
    },

    unreadCount(): number {
      const row = db
        .select({ n: sql<number>`count(*)` })
        .from(notifications)
        .where(isNull(notifications.readAt))
        .get();
      return row?.n ?? 0;
    },

    markRead(id: string): boolean {
      const res = db
        .update(notifications)
        .set({ readAt: Date.now() })
        .where(and(eq(notifications.id, id), isNull(notifications.readAt)))
        .run();
      if (res.changes > 0) return true;
      // Already read → idempotent success.
      return this.getRow(id) !== undefined;
    },

    markAllRead(): number {
      const res = db
        .update(notifications)
        .set({ readAt: Date.now() })
        .where(isNull(notifications.readAt))
        .run();
      return res.changes;
    },
  };
}

export type NotificationRepo = ReturnType<typeof createNotificationRepo>;
