<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import type { SessionDTO, AgentDTO } from '@pi-agent-platform/shared-types';

const router = useRouter();
const route = useRoute();

const sessions = ref<SessionDTO[]>([]);
const agents = ref<Map<string, AgentDTO>>(new Map());
const total = ref(0);
const loading = ref(true);

const page = ref(1);
const pageSize = ref(20);

const agentIdFilter = computed<string | null>(() => {
  const v = route.query.agent_id;
  return typeof v === 'string' ? v : null;
});

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

async function load() {
  loading.value = true;
  try {
    const params = new URLSearchParams();
    params.set('page', String(page.value));
    params.set('pageSize', String(pageSize.value));
    if (agentIdFilter.value) params.set('agent_id', agentIdFilter.value);
    const res = await fetch(`/api/sessions?${params}`);
    if (res.ok) {
      const data = (await res.json()) as { sessions: SessionDTO[]; total: number };
      sessions.value = data.sessions;
      total.value = data.total;
    }

    if (agents.value.size === 0) {
      const aRes = await fetch('/api/agents');
      if (aRes.ok) {
        const arr: AgentDTO[] = await aRes.json();
        const m = new Map<string, AgentDTO>();
        for (const a of arr) m.set(a.id, a);
        agents.value = m;
      }
    }
  } finally {
    loading.value = false;
  }
}

function openSession(id: string) {
  const agentId = sessions.value.find((s) => s.id === id)?.agentId;
  router.push(`/sessions/${id}${agentId ? `?agentId=${agentId}` : ''}`);
}

function agentName(id: string): string {
  return agents.value.get(id)?.name ?? '(unknown agent)';
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function workerUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// Reload when page / pageSize / filter changes.
watch([page, pageSize, agentIdFilter], load);

onMounted(load);
</script>

<template>
  <div class="max-w-3xl">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-2xl font-bold">Sessions</h2>
      <div class="flex items-center gap-3">
        <span v-if="agentIdFilter" class="text-xs text-blue-600">filtered by agent</span>
        <span class="text-xs text-gray-500">{{ total }} total</span>
      </div>
    </div>

    <!-- Page-size selector -->
    <div class="flex items-center justify-end gap-2 mb-2 text-xs text-gray-500">
      <label>Per page:</label>
      <select
        v-model.number="pageSize"
        class="px-2 py-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
      >
        <option :value="10">10</option>
        <option :value="20">20</option>
        <option :value="50">50</option>
        <option :value="100">100</option>
      </select>
    </div>

    <div v-if="loading" class="text-gray-500">Loading...</div>
    <div v-else-if="sessions.length === 0" class="text-gray-500">No sessions on this page.</div>

    <ul v-else class="space-y-2">
      <li
        v-for="s in sessions"
        :key="s.id"
        class="p-3 rounded border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer"
        @click="openSession(s.id)"
      >
        <div class="flex items-center justify-between gap-3">
          <div class="flex-1 min-w-0">
            <div class="font-medium truncate">
              {{ s.title || `Session ${s.id.slice(0, 8)}` }}
            </div>
            <div class="text-xs text-gray-500 truncate">
              {{ agentName(s.agentId) }} · {{ s.model }}
            </div>
            <div class="text-[10px] text-gray-400 mt-1">
              last active {{ timeAgo(s.lastActiveAt) }}
            </div>
          </div>
          <div class="flex flex-col items-end gap-1 shrink-0">
            <span
              v-if="s.worker"
              class="text-xs px-2 py-0.5 rounded bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 flex items-center gap-1"
              :title="`uptime ${workerUptime(s.worker.uptimeMs)} · pid ${s.worker.pid} · pending ${s.worker.pendingCalls}`"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-green-500"></span>
              worker pid {{ s.worker.pid }} · {{ workerUptime(s.worker.uptimeMs) }}
            </span>
            <span
              v-else
              class="text-xs px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 flex items-center gap-1"
              :title="`no worker running — message will respawn on next prompt`"
            >
              <span class="w-1.5 h-1.5 rounded-full bg-gray-400"></span>
              no worker
            </span>
          </div>
        </div>
      </li>
    </ul>

    <!-- Pagination -->
    <div v-if="totalPages > 1" class="flex items-center justify-center gap-3 mt-4 text-sm">
      <button
        class="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40"
        :disabled="page <= 1"
        @click="page--"
      >
        ‹ Prev
      </button>
      <span class="text-gray-600 dark:text-gray-400">
        Page {{ page }} / {{ totalPages }}
      </span>
      <button
        class="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 disabled:opacity-40"
        :disabled="page >= totalPages"
        @click="page++"
      >
        Next ›
      </button>
    </div>
  </div>
</template>