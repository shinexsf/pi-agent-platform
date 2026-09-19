<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import type { AgentDTO } from '@pi-agent-platform/shared-types';
import AppIcon from '../components/ui/AppIcon.vue';
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

// 内容型弹框已改为路由页（spec route-based-modals）
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
    // 打开新的独立会话页面（生产环境base是/web/）
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
    if (!res.ok) {
      throw new Error(`The agent couldn't be deleted (server response ${res.status}). Try again.`);
    }
    toast(`Agent「${agent.name}」已删除`, 'success');
    await loadAgents(false);
  } catch {
    toast('The agent couldn\'t be deleted. Check the server connection and try again.', 'error');
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
      <!-- 工具栏与列表同容器（spec app-layout「工具栏与列表绑定」） -->
      <div class="panel-toolbar">
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

      <ul v-else class="resource-list">
        <li v-for="agent in filteredAgents" :key="agent.id" class="resource-row">
          <div class="resource-row-inner">
            <div class="resource-identity">
              <span class="resource-avatar">{{ initials(agent.name) }}</span>
              <div class="resource-content">
                <h2 class="resource-title">{{ agent.name }}</h2>
                <div class="resource-meta">
                  <span class="meta-item truncate" :title="`${agent.model} · ${agent.workspacePath}`">
                    <AppIcon name="model" :size="14" />
                    <span>{{ agent.model }} · {{ agent.workspacePath }}</span>
                  </span>
                </div>
                <p v-if="agent.description" class="resource-description">{{ agent.description }}</p>
                <p class="resource-tools">Tools: {{ (agent.config?.builtinTools ?? []).join(', ') || 'default' }}</p>
              </div>
            </div>
            <div class="resource-actions">
              <router-link 
                class="btn btn-secondary btn-icon" 
                :to="`/sessions?agent_id=${agent.id}`"
                title="View sessions"
              >
                <AppIcon name="sessions" :size="16" />
              </router-link>
              <button
                class="btn btn-primary btn-icon"
                type="button"
                :class="{ 'is-loading': startingId === agent.id }"
                :disabled="startingId === agent.id || deletingId === agent.id"
                @click="startSession(agent.id)"
                title="New session"
              >
                <AppIcon :name="startingId === agent.id ? 'refresh' : 'plus'" :size="16" />
              </button>
              <button
                class="btn btn-secondary btn-icon"
                type="button"
                :aria-label="`Edit ${agent.name}`"
                title="Edit"
                @click="openEditModal(agent)"
              >
                <AppIcon name="edit" :size="16" />
              </button>
              <button
                class="btn btn-secondary btn-icon"
                type="button"
                :aria-label="`Delete ${agent.name}`"
                title="Delete"
                :disabled="deletingId === agent.id || startingId === agent.id"
                @click="deleteAgent(agent)"
              >
                <AppIcon name="trash" :size="16" />
              </button>
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

@media (max-width: 767px) {
  .panel-toolbar .agents-search,
  .panel-toolbar .toolbar-meta {
    width: 100%;
  }

  .toolbar-meta {
    justify-content: space-between;
  }

  .agents-search .search-input {
    min-width: 0;
  }
}
</style>
