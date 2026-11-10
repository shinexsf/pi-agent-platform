/**
 * Notifier — the ONE write entry point for the **system notification table**
 * (`notifications`).
 *
 * Standalone subsystem, not a trigger feature: the trigger runner is merely one
 * caller. Sources are exactly three:
 *   1. the agent's `postNotification` tool (reverse-call from the worker)
 *   2. the trigger runner, when a firing fails
 *   3. server-internal failures (explicit `notify()` calls, e.g. startup problems)
 *
 * Never derived from assistant messages: an agent has to ask.
 *
 * `notify()` only inserts a row. There is deliberately NO delivery layer: no
 * channel config, no retries, no batching, no dedupe, no outbound HTTP. Anything
 * that wants to push notifications elsewhere (MCP server, plugin, cron script)
 * consumes `GET /api/notifications` on its own — the platform does not provide a
 * consumer cursor, and `read_at` means "the user read it", nothing else.
 */

import type { NotificationRepo } from '../repos/notification.repo.js';
import type { NotificationDTO, NotificationSeverity } from '@pi-agent-platform/shared-types';

export interface NotifyInput {
  severity?: NotificationSeverity;
  title: string;
  body: string;
  /** `agent` | `trigger` | `server` — free-form so new internal callers need no schema change. */
  source: string;
  sourceId?: string | null;
  /** Server-built deep link — never taken from an agent / plugin. */
  actionUrl?: string | null;
}

export interface NotifierDeps {
  notificationRepo: NotificationRepo;
}

export interface Notifier {
  notify(input: NotifyInput): Promise<NotificationDTO>;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const { notificationRepo } = deps;

  return {
    async notify(input: NotifyInput): Promise<NotificationDTO> {
      return notificationRepo.create({
        severity: input.severity ?? 'info',
        title: input.title,
        body: input.body,
        source: input.source,
        sourceId: input.sourceId ?? null,
        actionUrl: input.actionUrl ?? null,
      });
    },
  };
}
