/**
 * useNotifications — notification inbox + the header bell badge
 * (change: trigger-scheduling).
 *
 * `unreadCount` is a MODULE-level singleton `ref`: the bell lives in AppShell
 * while the inbox is a route, and both must show the same number without
 * introducing a store. Refreshed by a 30s poll and on route change.
 */

import { ref } from 'vue';
import type { NotificationDTO, NotificationSeverity } from '@pi-agent-platform/shared-types';

const unreadCount = ref(0);
let pollTimer: ReturnType<typeof setInterval> | null = null;

export function useNotifications() {
  const items = ref<NotificationDTO[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function refreshCount(): Promise<void> {
    try {
      const res = await fetch('/api/notifications?limit=1');
      if (!res.ok) return;
      const data = (await res.json()) as { unreadCount: number };
      unreadCount.value = data.unreadCount;
    } catch {
      /* offline — badge keeps its last value */
    }
  }

  async function load(filter: { unread?: boolean; severity?: NotificationSeverity } = {}): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (filter.unread) params.set('unread', '1');
      if (filter.severity) params.set('severity', filter.severity);
      const res = await fetch(`/api/notifications?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items: NotificationDTO[]; unreadCount: number };
      items.value = data.items;
      unreadCount.value = data.unreadCount;
    } catch (err) {
      error.value = (err as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function markRead(id: string): Promise<void> {
    try {
      const res = await fetch(`/api/notifications/${id}/read`, { method: 'POST' });
      if (!res.ok) return;
      const data = (await res.json()) as { unreadCount: number };
      unreadCount.value = data.unreadCount;
      const row = items.value.find((n) => n.id === id);
      if (row) row.readAt = Date.now();
    } catch {
      /* keep the UI usable; the next load reconciles */
    }
  }

  async function markAllRead(): Promise<void> {
    try {
      const res = await fetch('/api/notifications/read-all', { method: 'POST' });
      if (!res.ok) return;
      unreadCount.value = 0;
      for (const row of items.value) row.readAt ??= Date.now();
    } catch {
      /* ignore */
    }
  }

  /** Start the 30s badge poll (idempotent — AppShell calls it once). */
  function startPolling(): void {
    if (pollTimer !== null) return;
    void refreshCount();
    pollTimer = setInterval(() => void refreshCount(), 30_000);
  }

  return { items, loading, error, unreadCount, load, markRead, markAllRead, refreshCount, startPolling };
}
