<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import type { SessionDTO, AgentDTO } from '@pi-agent-platform/shared-types';
import AppIcon from '../components/ui/AppIcon.vue';

const router = useRouter();
const route = useRoute();

const sessions = ref<SessionDTO[]>([]);
const agents = ref<Map<string, AgentDTO>>(new Map());
const allAgents = ref<AgentDTO[]>([]);
const total = ref(0);
const loading = ref(true);
const loadError = ref<string | null>(null);
const page = ref(1);
const pageSize = ref(20);

const selectedAgentId = ref<string>('');
const agentSearchQuery = ref('');
const showAgentDropdown = ref(false);
const searchQuery = ref('');
const debouncedSearch = ref('');

const agentInputRef = ref<HTMLInputElement | null>(null);

const filteredAgents = computed(() => {
  if (!agentSearchQuery.value.trim()) return allAgents.value;
  const query = agentSearchQuery.value.toLowerCase();
  return allAgents.value.filter(a => a.name.toLowerCase().includes(query));
});

const selectedAgentName = computed(() => {
  if (!selectedAgentId.value) return '';
  return allAgents.value.find(a => a.id === selectedAgentId.value)?.name ?? '';
});

function selectAgent(agent: AgentDTO | null) {
  selectedAgentId.value = agent?.id ?? '';
  agentSearchQuery.value = '';
  showAgentDropdown.value = false;
  onAgentFilterChange();
}

// Click outside directive
const vClickOutside = {
  mounted(el: HTMLElement, binding: { value: () => void }) {
    (el as any)._clickOutsideHandler = (event: MouseEvent) => {
      if (!el.contains(event.target as Node)) {
        binding.value();
      }
    };
    document.addEventListener('click', (el as any)._clickOutsideHandler);
  },
  unmounted(el: HTMLElement) {
    if ((el as any)._clickOutsideHandler) {
      document.removeEventListener('click', (el as any)._clickOutsideHandler);
    }
  },
};

// Initialize from route query
onMounted(() => {
  const agentId = route.query.agent_id;
  if (typeof agentId === 'string' && agentId) {
    selectedAgentId.value = agentId;
  }
});

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

// Debounce search input
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
watch(searchQuery, (val) => {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    debouncedSearch.value = val;
    page.value = 1;
    load();
  }, 300);
});

function showToast(message: string, variant: 'info' | 'success' | 'error' = 'info') {
  window.dispatchEvent(new CustomEvent('im-gateway:toast', { detail: { message, variant } }));
}

async function load() {
  loading.value = true;
  loadError.value = null;
  try {
    const params = new URLSearchParams({
      page: String(page.value),
      pageSize: String(pageSize.value),
    });
    if (selectedAgentId.value) params.set('agent_id', selectedAgentId.value);
    if (debouncedSearch.value) params.set('search', debouncedSearch.value);

    const [sessionsRes, agentsRes] = await Promise.all([
      fetch(`/api/sessions?${params}`),
      allAgents.value.length === 0 ? fetch('/api/agents') : Promise.resolve(null),
    ]);

    if (!sessionsRes.ok) throw new Error(`The server returned ${sessionsRes.status}.`);
    const data = (await sessionsRes.json()) as { sessions: SessionDTO[]; total: number };
    sessions.value = data.sessions;
    total.value = data.total;

    if (agentsRes?.ok) {
      const list: AgentDTO[] = await agentsRes.json();
      allAgents.value = list;
      agents.value = new Map(list.map((agent) => [agent.id, agent]));
    }

    if (page.value > totalPages.value) page.value = totalPages.value;
  } catch {
    loadError.value = 'Check the server connection and try again.';
    if (sessions.value.length > 0) {
      showToast(`Sessions couldn't be refreshed. ${loadError.value}`, 'error');
    }
  } finally {
    loading.value = false;
  }
}

async function openSession(session: SessionDTO) {
  await router.push(`/sessions/${session.id}${session.agentId ? `?agentId=${session.agentId}` : ''}`);
}

function onAgentFilterChange() {
  page.value = 1;
  load();
}

function clearFilter() {
  selectedAgentId.value = '';
  searchQuery.value = '';
  page.value = 1;
  load();
}

function agentName(id: string): string {
  return agents.value.get(id)?.name ?? 'Unknown agent';
}

function timeAgo(timestamp: number): string {
  const difference = Math.max(0, Date.now() - timestamp);
  if (difference < 60_000) return 'just now';
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)}m ago`;
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function workerUptime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function sessionTransitionName(id: string): string {
  return `session-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

watch(page, () => load());
watch(pageSize, () => {
  if (page.value === 1) load();
  else page.value = 1;
});

onMounted(() => load());
</script>

<template>
  <section class="page-shell" aria-labelledby="sessions-title">
    <header class="page-heading">
      <div class="page-actions">
        <span class="page-count">{{ total }} {{ total === 1 ? 'session' : 'sessions' }}</span>
        <button
          class="btn btn-secondary btn-icon"
          type="button"
          :class="{ 'is-loading': loading }"
          :disabled="loading"
          aria-label="Refresh sessions"
          @click="load()"
        >
          <AppIcon name="refresh" :size="16" />
        </button>
      </div>
    </header>

    <div class="surface-panel" :aria-busy="loading">
      <div class="panel-toolbar">
        <div class="panel-toolbar-group search-filters">
          <div class="agent-dropdown-wrapper" v-click-outside="() => showAgentDropdown = false">
            <div class="agent-input-wrapper">
              <input
                ref="agentInputRef"
                type="text"
                class="control agent-filter-input"
                :class="{ 'has-value': selectedAgentId && !agentSearchQuery }"
                :placeholder="selectedAgentId ? '' : 'Filter by agent...'"
                :value="agentSearchQuery || (selectedAgentId ? selectedAgentName : '')"
                @input="(e: Event) => { agentSearchQuery = (e.target as HTMLInputElement).value; showAgentDropdown = true; }"
                @focus="showAgentDropdown = true"
              />
              <button 
                v-if="selectedAgentId" 
                type="button" 
                class="agent-clear-btn"
                @click="selectAgent(null)"
              >×</button>
            </div>
            <div v-if="showAgentDropdown && (filteredAgents.length > 0 || selectedAgentId || agentSearchQuery)" class="agent-dropdown">
              <div 
                v-for="agent in filteredAgents" 
                :key="agent.id" 
                class="agent-option"
                :class="{ active: selectedAgentId === agent.id }"
                @mousedown.prevent="selectAgent(agent)"
              >
                {{ agent.name }}
              </div>
              <div v-if="filteredAgents.length === 0 && agentSearchQuery" class="agent-option empty">
                No matching agents
              </div>
            </div>
          </div>
          <input
            v-model="searchQuery"
            type="text"
            class="control search-input"
            placeholder="Search by title..."
          />

        </div>
        <label class="panel-toolbar-group page-count">
          Rows per page
          <select v-model.number="pageSize" class="control select-compact" aria-label="Sessions per page">
            <option :value="10">10</option>
            <option :value="20">20</option>
            <option :value="50">50</option>
            <option :value="100">100</option>
          </select>
        </label>
      </div>

      <div v-if="loading" class="skeleton-list" aria-label="Loading sessions" aria-live="polite">
        <div class="loading-caption">Loading sessions…</div>
        <div v-for="index in 4" :key="index" class="skeleton-row">
          <span class="skeleton-avatar" />
          <span class="skeleton-copy">
            <span class="skeleton-line" />
            <span class="skeleton-line short" />
          </span>
        </div>
      </div>

      <div v-else-if="loadError && sessions.length === 0" class="state-panel">
        <div class="state-content">
          <span class="state-icon"><AppIcon name="alert" :size="23" /></span>
          <h2 class="state-title">Sessions couldn't be loaded</h2>
          <p class="state-copy">{{ loadError }}</p>
          <button class="btn btn-secondary state-action" type="button" @click="load()">Try again</button>
        </div>
      </div>

      <div v-else-if="sessions.length === 0" class="state-panel">
        <div class="state-content">
          <span class="state-icon"><AppIcon name="sessions" :size="23" /></span>
          <h2 class="state-title">
            {{ selectedAgentId || searchQuery ? 'No matching sessions' : page > 1 ? 'No sessions on this page' : 'No sessions yet' }}
          </h2>
        </div>
      </div>

      <ul v-else class="resource-list">
        <li v-for="session in sessions" :key="session.id" class="resource-row">
          <button
            class="session-row-button"
            type="button"
            :style="{ viewTransitionName: sessionTransitionName(session.id) }"
            @click="openSession(session)"
          >
            <span class="resource-identity">
              <span class="resource-avatar"><AppIcon name="sessions" :size="18" /></span>
              <span class="resource-content">
                <span class="resource-title">{{ session.title || `Session ${session.id.slice(0, 8)}` }}</span>
                <span class="resource-meta">
                  <span class="meta-item">
                    <AppIcon name="agents" :size="14" />
                    <span>{{ agentName(session.agentId) }} · {{ session.model }}</span>
                  </span>
                  <span class="meta-item">
                    <AppIcon name="clock" :size="14" />
                    <span>Active {{ timeAgo(session.lastActiveAt) }}</span>
                  </span>
                </span>
              </span>
            </span>
            <span class="session-runtime">
              <span
                v-if="session.worker"
                class="status-badge is-live"
                :title="`Worker uptime ${workerUptime(session.worker.uptimeMs)} · PID ${session.worker.pid} · ${session.worker.pendingCalls} pending calls`"
              >
                Worker active · PID {{ session.worker.pid }} · {{ workerUptime(session.worker.uptimeMs) }}
              </span>
              <span v-else class="status-badge" title="No worker is active. Sending a new message will start one.">
                Worker stopped
              </span>
              <AppIcon name="chevron-right" :size="17" class="session-chevron" />
            </span>
          </button>
        </li>
      </ul>

      <div v-if="!loading && totalPages > 1" class="pagination">
        <span class="pagination-label">Page {{ page }} of {{ totalPages }}</span>
        <div class="pagination-actions">
          <button
            class="btn btn-secondary"
            type="button"
            :disabled="page <= 1"
            @click="page--"
          >
            Previous
          </button>
          <button
            class="btn btn-secondary"
            type="button"
            :disabled="page >= totalPages"
            @click="page++"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.filter-clear {
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: currentColor;
  line-height: 1;
  cursor: pointer;
}

.filter-clear:hover {
  background: color-mix(in srgb, currentColor 11%, transparent);
}

.session-row-button {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 20px;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 160ms ease;
}

.session-row-button:hover {
  background: var(--surface-subtle);
}

.session-row-button:hover .session-chevron {
  color: var(--accent);
  transform: translateX(2px);
}

.session-runtime {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 12px;
}

.session-chevron {
  color: var(--text-tertiary);
  transition: color 150ms ease, transform 150ms ease;
}

@media (max-width: 680px) {
  .session-row-button {
    align-items: flex-start;
    flex-direction: column;
    gap: 13px;
    padding: 17px 15px;
  }

  .session-runtime {
    width: 100%;
    justify-content: space-between;
    padding-left: 52px;
  }
}

.search-filters {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.agent-filter {
  min-width: 150px;
}

.search-input {
  min-width: 200px;
  flex: 1;
}

.btn-sm {
  padding: 4px 8px;
  font-size: 0.8rem;
}

.agent-dropdown-wrapper {
  position: relative;
  min-width: 180px;
}

.agent-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.agent-filter-input {
  width: 100%;
  padding-right: 24px;
}

.agent-filter-input.has-value {
  color: var(--text);
  font-weight: 500;
}

.agent-clear-btn {
  position: absolute;
  right: 6px;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.agent-clear-btn:hover {
  color: var(--text);
}

.agent-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  max-height: 200px;
  overflow-y: auto;
  z-index: 100;
}

.agent-option {
  padding: 8px 12px;
  cursor: pointer;
  font-size: 0.9rem;
  color: var(--text);
}

.agent-option:hover {
  background: var(--surface-hover);
}

.agent-option.active {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.agent-option.empty {
  color: var(--text-secondary);
  cursor: default;
}

.agent-option-clear {
  margin-right: 8px;
  color: var(--text-secondary);
}
</style>
