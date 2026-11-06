/**
 * useTriggers — trigger list / CRUD helpers for the web console
 * (change: trigger-scheduling).
 *
 * Deliberately NOT a Pinia store: pages own their state with `ref`s, like
 * `views/config/*`. The only cross-page state is the notification unread count
 * (see useNotifications).
 */

import { ref } from 'vue';
import type { TriggerDTO, TriggerRunDTO, TriggerSourceInfo } from '@pi-agent-platform/shared-types';
import type { CreateTriggerRequest, UpdateTriggerRequest } from '@pi-agent-platform/api-types';

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Unexpected response (${res.status})`);
  }
  if (!res.ok) {
    const message = (parsed as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return parsed as T;
}

export function useTriggers() {
  const triggers = ref<TriggerDTO[]>([]);
  const sources = ref<TriggerSourceInfo[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load(filter: { agentId?: string; source?: string; includeDisabled?: boolean } = {}) {
    loading.value = true;
    error.value = null;
    try {
      const params = new URLSearchParams();
      if (filter.agentId) params.set('agentId', filter.agentId);
      if (filter.source) params.set('source', filter.source);
      if (filter.includeDisabled !== false) params.set('includeDisabled', '1');
      const res = await fetch(`/api/triggers?${params}`);
      const data = await jsonOrThrow<{ items: TriggerDTO[]; sources: TriggerSourceInfo[] }>(res);
      triggers.value = data.items;
      sources.value = data.sources;
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function get(id: string): Promise<TriggerDTO & { recentRuns?: TriggerRunDTO[]; secret?: string }> {
    const res = await fetch(`/api/triggers/${id}`);
    return jsonOrThrow(res);
  }

  async function create(body: CreateTriggerRequest): Promise<TriggerDTO & { secret?: string }> {
    const res = await fetch('/api/triggers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return jsonOrThrow(res);
  }

  async function update(id: string, body: UpdateTriggerRequest): Promise<TriggerDTO> {
    const res = await fetch(`/api/triggers/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return jsonOrThrow(res);
  }

  async function remove(id: string): Promise<void> {
    const res = await fetch(`/api/triggers/${id}`, { method: 'DELETE' });
    await jsonOrThrow(res);
  }

  async function runNow(id: string, payload?: unknown): Promise<{ status: string; error?: string }> {
    const res = await fetch(`/api/triggers/${id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload === undefined ? {} : { payload }),
    });
    return jsonOrThrow(res);
  }

  async function runs(id: string, limit = 20): Promise<TriggerRunDTO[]> {
    const res = await fetch(`/api/triggers/${id}/runs?limit=${limit}`);
    const data = await jsonOrThrow<{ items: TriggerRunDTO[] }>(res);
    return data.items;
  }

  async function rotateSecret(id: string): Promise<string> {
    const res = await fetch(`/api/triggers/${id}/rotate-secret`, { method: 'POST' });
    const data = await jsonOrThrow<{ secret: string }>(res);
    return data.secret;
  }

  return { triggers, sources, loading, error, load, get, create, update, remove, runNow, runs, rotateSecret };
}

/** `next_at` / `last_fired_at` → relative, compact ("in 2h", "3m ago"). */
export function relativeTime(at: number | null | undefined): string {
  if (!at) return '—';
  const delta = at - Date.now();
  const abs = Math.abs(delta);
  const unit =
    abs < 60_000
      ? [`${Math.round(abs / 1000)}s`, `${Math.round(abs / 1000)}s`]
      : abs < 3_600_000
        ? [`${Math.round(abs / 60_000)}m`, `${Math.round(abs / 60_000)}m`]
        : abs < 86_400_000
          ? [`${Math.round(abs / 3_600_000)}h`, `${Math.round(abs / 3_600_000)}h`]
          : [`${Math.round(abs / 86_400_000)}d`, `${Math.round(abs / 86_400_000)}d`];
  return delta >= 0 ? `in ${unit[0]}` : `${unit[1]} ago`;
}

export function absoluteTime(at: number | null | undefined): string {
  if (!at) return '—';
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Human summary of a trigger's schedule (source-agnostic). */
export function scheduleSummary(trigger: TriggerDTO): string {
  const cfg = trigger.config ?? {};
  if (trigger.source === 'cron') return `${cfg.expr ?? '?'} (${cfg.tz ?? 'local'})`;
  if (trigger.source === 'once') return `at ${absoluteTime(Number(cfg.at) || null)}`;
  if (trigger.source === 'webhook') return 'HTTP';
  return trigger.source;
}
