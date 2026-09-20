<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import type { AgentDTO } from '@pi-agent-platform/shared-types';
import AppIcon from '../components/ui/AppIcon.vue';
import DropdownMenu from '../components/ui/DropdownMenu.vue';
import { confirmDelete, toast } from '../composables/useFeedback';

const router = useRouter();
const agents = ref<AgentDTO[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const startingId = ref<string | null>(null);
const deletingId = ref<string | null>(null);
const searchQuery = ref('');

const filteredAgents = computed(() => {
  if (!searchQuery.value.trim()) return agents.value;
  const query = searchQuery.value.toLowerCase();
  return agents.value.filter(a =>
    a.name.toLowerCase().includes(query) ||
    (a.description ?? '').toLowerCase().includes(query)
  );
});

async function loadAgents(showLoading = true) {
  if (showLoading) loading.value = true;
  loadError.value = null;
  try {
    const agentsRes = await fetch('/api/agents');
    if (!agentsRes.ok) throw new Error(`Server response ${agentsRes.status}`);
    agents.value = (await agentsRes.json()) as AgentDTO[];
  } catch {
    loadError.value = 'Check the server connection and try again.';
    if (agents.value.length > 0) {
      toast(`Agents couldn't be refreshed. ${loadError.value}`, 'error');
    }
  } finally {
    loading.value = false;
  }
}

function openCreateModal(): void {
  void router.push('/agents/new');
}

function openEditModal(agent: AgentDTO): void {
  void router.push(`/agents/${agent.id}/edit`);
}

async function startSession(agentId: string) {
  startingId.value = agentId;
  try {
    const res = await fetch(`/api/sessions/agents/${agentId}`, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`The session couldn't be created (server response ${res.status}). Try again.`);
    }
    const data = (await res.json()) as { sessionId: string; agentId: string };
    const base = import.meta.env.BASE_URL || '/';
    window.open(`${base}chat/${data.sessionId}?agentId=${data.agentId}`, '_blank');
  } catch {
    toast('The session couldn\'t be created. Check the server connection and try again.', 'error');
  } finally {
    startingId.value = null;
  }
}

async function deleteAgent(agent: AgentDTO) {
  const confirmed = await confirmDelete('Agent', agent.name);
  if (!confirmed) return;
  deletingId.value = agent.id;
  try {
    const res = await fetch(`/api/agents/${agent.id}/delete`, { method: 'POST' });
    if (!res.ok) throw new Error(`The agent couldn't be deleted (server response ${res.status}). Try again.`);
    toast(`Agent「${agent.name}」已删除`, 'success');
    await loadAgents(false);
  } catch {
    toast("The agent couldn't be deleted. Check the server connection and try again.", 'error');
  } finally {
    deletingId.value = null;
  }
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('');
}

onMounted(() => loadAgents());
</script>

<template>
  <section class="page-shell" aria-labelledby="agents-title">
    <div class="surface-panel" :aria-busy="loading">
      <!-- 工具栏 -->
      <div class="panel-toolbar agents-toolbar">
        <div class="panel-toolbar-group agents-search">
          <input
            v-model="searchQuery"
            type="text"
            class="control search-input"
            placeholder="Search agents..."
          />
        </div>

        <div class="panel-toolbar-group toolbar-meta">
          <span class="page-count">
            {{ filteredAgents.length }} {{ filteredAgents.length === 1 ? 'agent' : 'agents' }}
          </span>
          <button
            class="btn btn-primary btn-icon"
            type="button"
            title="New agent"
            aria-label="New agent"
            @click="openCreateModal"
          >
            <AppIcon name="plus" :size="16" />
          </button>
          <button
            class="btn btn-secondary btn-icon"
            type="button"
            :class="{ 'is-loading': loading }"
            :disabled="loading"
            aria-label="Refresh agents"
            @click="loadAgents()"
          >
            <AppIcon name="refresh" :size="16" />
          </button>
        </div>
      </div>

      <!-- loading / error / empty -->
      <div v-if="loading" class="skeleton-list" aria-label="Loading agents" aria-live="polite">
        <div class="loading-caption">Loading agents…</div>
        <div v-for="index in 3" :key="index" class="skeleton-row">
          <span class="skeleton-avatar" />
          <span class="skeleton-copy">
            <span class="skeleton-line" />
            <span class="skeleton-line short" />
          </span>
        </div>
      </div>

      <div v-else-if="loadError && agents.length === 0" class="state-panel">
        <div class="state-content">
          <span class="state-icon"><AppIcon name="alert" :size="23" /></span>
          <h2 class="state-title">Agents couldn't be loaded</h2>
          <p class="state-copy">{{ loadError }}</p>
          <button class="btn btn-secondary state-action" type="button" @click="loadAgents()">Try again</button>
        </div>
      </div>

      <div v-else-if="filteredAgents.length === 0" class="state-panel">
        <div class="state-content">
          <span class="state-icon"><AppIcon name="agents" :size="23" /></span>
          <h2 class="state-title">{{ searchQuery ? 'No matching agents' : 'No agents configured' }}</h2>
        </div>
      </div>

      <!-- agent 列表 -->
      <ul v-else class="resource-list agent-list">
        <li v-for="agent in filteredAgents" :key="agent.id" class="resource-row agent-row">
          <div class="agent-row-main" @click="router.push(`/agents/${agent.id}`)">
            <span class="resource-avatar agent-avatar">{{ initials(agent.name) }}</span>
            <div class="agent-info">
              <span class="agent-name">{{ agent.name }}</span>
              <span class="agent-meta truncate" :title="`${agent.model} · ${agent.workspacePath}`">
                {{ agent.model }} · {{ agent.workspacePath }}
              </span>
            </div>
            <div class="agent-row-right">
              <button class="btn-icon-sm is-live" type="button" title="新建会话"
                :class="{ 'is-loading': startingId === agent.id }"
                :disabled="startingId === agent.id || deletingId === agent.id"
                @click.stop="startSession(agent.id)">
                <AppIcon :name="startingId === agent.id ? 'refresh' : 'play'" :size="14" />
              </button>
              <button class="btn-icon-sm" type="button" title="查看会话" @click.stop="router.push(`/sessions?agent_id=${agent.id}`)">
                <AppIcon name="sessions" :size="14" />
              </button>
              <DropdownMenu>
                <button class="dropdown-item" @click.stop="openEditModal(agent)">
                  <AppIcon name="edit" :size="14" />
                  <span>编辑</span>
                </button>
                <button class="dropdown-item is-danger" :disabled="deletingId === agent.id" @click.stop="deleteAgent(agent)">
                  <AppIcon name="trash" :size="14" />
                  <span>删除</span>
                </button>
              </DropdownMenu>
            </div>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.toolbar-meta {
  display: flex;
  flex: none;
  align-items: center;
  gap: 12px;
}

.agents-search {
  flex: 1;
  min-width: 0;
}

/* --- agent row --- */
.agent-row { padding: 0; }
.agent-row-main { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; padding: 8px 12px; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; transition: background 120ms; }
.agent-row-main:hover { background: var(--surface-subtle); }
.agent-avatar { flex: 0 0 28px; width: 28px; height: 28px; font-size: 11px; border-radius: 6px; display: grid; place-items: center; background: var(--surface-subtle); color: var(--text-secondary); }
.agent-info { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.agent-name { font-size: 0.88rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.agent-meta { font-size: 0.78rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.agent-row-right { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
.btn-icon-sm { display: inline-flex; width: 26px; height: 26px; align-items: center; justify-content: center; border: 0; border-radius: 6px; background: transparent; color: var(--text-secondary); cursor: pointer; padding: 0; }
.btn-icon-sm:hover { background: var(--surface-hover); color: var(--text); }
.btn-icon-sm.is-live { color: var(--success); }
.btn-icon-sm.is-live:hover { background: var(--success-soft); }
.dropdown-item { display: flex; align-items: center; gap: 6px; width: 100%; padding: 6px 10px; border: 0; background: transparent; color: var(--text); font-size: 0.8rem; text-align: left; cursor: pointer; white-space: nowrap; }
.dropdown-item:hover { background: var(--surface-hover); }
.dropdown-item.is-danger { color: var(--danger); }
.dropdown-item.is-danger:hover { background: var(--danger-soft); }

/* --- compact --- */
@media (max-width: 767px) {
  .panel-toolbar .agents-search,
  .panel-toolbar .toolbar-meta {
    width: 100%;
  }

  .panel-toolbar.agents-toolbar {
    flex-direction: row;
    flex-wrap: wrap;
  }

  .toolbar-meta {
    justify-content: flex-end;
  }

  .agents-search .search-input {
    min-width: 0;
  }
}
</style>
