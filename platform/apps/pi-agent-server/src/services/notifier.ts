/**
 * Notifier — the ONE entry point for notifications (change: trigger-scheduling,
 * capability `trigger-notifications`).
 *
 * Notification sources are exactly three:
 *   1. the agent's `sendNotifyToUser` tool (reverse-call from the worker)
 *   2. the trigger runner, when a firing fails
 *   3. server-internal failures (explicit `notify()` calls, e.g. startup problems)
 *
 * Never derived from assistant messages: an agent has to ask.
 *
 * Delivery channels live in `~/.pi/server/notifications.json` (same style as
 * `mcp.json`) and are plain URL templates — no retries, no batching, no
 * dedupe. A failing channel records `delivery_error` and never blocks the row.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { NotificationRepo } from '../repos/notification.repo.js';
import type {
  NotificationDeliveryDTO,
  NotificationDTO,
  NotificationSeverity,
} from '@pi-agent-platform/shared-types';
import { childLogger } from '../logger.js';

const logger = childLogger('notifier');

export interface NotificationChannel {
  /** Stable name shown in `deliveries`. */
  name: string;
  /** `info` < `warning` < `error` — only notify when severity >= this. */
  minSeverity?: NotificationSeverity;
  /**
   * URL template. Placeholders: `{{title}}` `{{body}}` `{{severity}}`
   * (URL-encoded on substitution). Covers Bark / ntfy / PushPlus /
   * WeCom bot / generic webhooks.
   */
  urlTemplate: string;
  method?: 'GET' | 'POST';
  /** Optional JSON body template for POST channels. */
  bodyTemplate?: string;
}

interface NotificationsFile {
  channels?: NotificationChannel[];
  /** Default minimum severity for channels that don't set one. */
  minSeverity?: NotificationSeverity;
}

const SEVERITY_RANK: Record<NotificationSeverity, number> = { info: 0, warning: 1, error: 2 };

let channelsCache: { at: number; channels: NotificationChannel[]; defaultMin: NotificationSeverity } | undefined;
const CHANNEL_CACHE_MS = 10_000;

function readChannels(configPath: string): { channels: NotificationChannel[]; defaultMin: NotificationSeverity } {
  const now = Date.now();
  if (channelsCache && now - channelsCache.at < CHANNEL_CACHE_MS) return channelsCache;

  const result = { channels: [] as NotificationChannel[], defaultMin: 'info' as NotificationSeverity };
  if (!existsSync(configPath)) {
    channelsCache = { at: now, ...result };
    return channelsCache;
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as NotificationsFile;
    if (parsed.minSeverity) result.defaultMin = parsed.minSeverity;
    for (const raw of parsed.channels ?? []) {
      if (!raw || typeof raw.urlTemplate !== 'string' || !raw.urlTemplate) continue;
      if (!raw.name) continue;
      result.channels.push({ ...raw, minSeverity: raw.minSeverity ?? result.defaultMin });
    }
  } catch (err) {
    logger.warn({ err, configPath }, 'notifications.json unreadable; inbox-only');
  }
  channelsCache = { at: now, ...result };
  return channelsCache;
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => {
    const value = vars[key];
    return value === undefined ? whole : encodeURIComponent(value);
  });
}

function fillBodyTemplate(template: string, vars: Record<string, string>): string {
  // Body templates are JSON: substitute raw (they are template-author controlled)
  // but keep values JSON-safe by going through JSON.stringify of the value.
  return template.replace(/"\{\{(\w+)\}\}"/g, (_whole, key: string) => {
    const value = vars[key];
    return value === undefined ? '""' : JSON.stringify(value);
  });
}

export interface NotifyInput {
  severity?: NotificationSeverity;
  title: string;
  body: string;
  /** `agent` | `trigger` | `server` */
  source: string;
  sourceId?: string | null;
  /** Server-built deep link — never taken from an agent// plugin. */
  actionUrl?: string | null;
  /** Skip channel delivery (record only). */
  silent?: boolean;
}

export interface NotifierDeps {
  notificationRepo: NotificationRepo;
  notificationsConfigPath: string;
}

export interface Notifier {
  notify(input: NotifyInput): Promise<NotificationDTO>;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const { notificationRepo, notificationsConfigPath } = deps;

  async function deliver(
    severity: NotificationSeverity,
    title: string,
    body: string,
  ): Promise<NotificationDeliveryDTO[]> {
    const { channels } = readChannels(notificationsConfigPath);
    const out: NotificationDeliveryDTO[] = [];
    const vars = { title, body, severity };
    for (const channel of channels) {
      const min = channel.minSeverity ?? 'info';
      if (SEVERITY_RANK[severity] < SEVERITY_RANK[min]) continue;
      const url = fillTemplate(channel.urlTemplate, vars);
      try {
        const init: RequestInit = { method: channel.method ?? 'GET' };
        if (init.method === 'POST') {
          init.headers = { 'content-type': 'application/json' };
          init.body = channel.bodyTemplate
            ? fillBodyTemplate(channel.bodyTemplate, vars)
            : JSON.stringify({ title, body, severity });
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        try {
          const res = await fetch(url, { ...init, signal: controller.signal });
          out.push({
            channel: channel.name,
            ok: res.ok,
            ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
            at: Date.now(),
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        // No retry, no batching — one attempt, one recorded outcome.
        out.push({ channel: channel.name, ok: false, error: (err as Error).message, at: Date.now() });
      }
    }
    return out;
  }

  return {
    async notify(input: NotifyInput): Promise<NotificationDTO> {
      const severity = input.severity ?? 'info';
      const deliveries = input.silent ? [] : await deliver(severity, input.title, input.body);
      const row = notificationRepo.create({
        severity,
        title: input.title,
        body: input.body,
        source: input.source,
        sourceId: input.sourceId ?? null,
        actionUrl: input.actionUrl ?? null,
        deliveries,
      });
      const failed = deliveries.filter((d) => !d.ok);
      if (failed.length > 0) {
        logger.warn({ id: row.id, failed }, 'notification delivery failed (recorded, not retried)');
      }
      return row;
    },
  };
}
