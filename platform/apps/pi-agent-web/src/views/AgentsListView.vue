<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import type { AgentDTO } from '@pi-agent-platform/shared-types';
import AppIcon from '../components/ui/AppIcon.vue';

const router = useRouter();
const agents = ref<AgentDTO[]>([]);
const allModels = ref<{ provider: string; modelId: string; displayName: string }[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const startingId = ref<string | null>(null);
const deletingId = ref<string | null>(null);
const searchQuery = ref('');

// Modal state
const showModal = ref(false);
const editingAgent = ref<AgentDTO | null>(null);
const saving = ref(false);
const formData = ref({
  name: '',
  model: '',
  description: '',
  workspacePath: '',
  systemPrompt: '',
  appendSystemPrompt: '',
  tools: [] as string[],
});

const filteredAgents = computed(() => {
  if (!searchQuery.value.trim()) return agents.value;
  const query = searchQuery.value.toLowerCase();
  return agents.value.filter(a => 
    a.name.toLowerCase().includes(query) || 
    (a.description ?? '').toLowerCase().includes(query)
  );
});

const isEditing = computed(() => editingAgent.value !== null);
const modalTitle = computed(() => isEditing.value ? 'Edit Agent' : 'New Agent');

function showToast(message: string, variant: 'info' | 'success' | 'error' = 'info') {
  window.dispatchEvent(new CustomEvent('im-gateway:toast', { detail: { message, variant } }));
}

async function loadAgents(showLoading = true) {
  if (showLoading) loading.value = true;
  loadError.value = null;
  try {
    const [agentsRes, modelsRes] = await Promise.all([
      fetch('/api/agents'),
      allModels.value.length === 0 ? fetch('/api/models') : Promise.resolve(null),
    ]);
    if (!agentsRes.ok) throw new Error(`Server response ${agentsRes.status}`);
    agents.value = await agentsRes.json();
    if (modelsRes?.ok) {
      allModels.value = await modelsRes.json();
    }
  } catch {
    loadError.value = 'Check the server connection and try again.';
    if (agents.value.length > 0) {
      showToast(`Agents couldn't be refreshed. ${loadError.value}`, 'error');
    }
  } finally {
    loading.value = false;
  }
}

function openCreateModal() {
  editingAgent.value = null;
  formData.value = {
    name: '',
    model: '',
    description: '',
    workspacePath: '',
    systemPrompt: '',
    appendSystemPrompt: '',
    tools: [],
  };
  showModal.value = true;
}

function openEditModal(agent: AgentDTO) {
  editingAgent.value = agent;
  formData.value = {
    name: agent.name,
    model: agent.model,
    description: agent.description ?? '',
    workspacePath: agent.workspacePath,
    systemPrompt: agent.systemPrompt ?? '',
    appendSystemPrompt: agent.appendSystemPrompt ?? '',
    tools: [...(agent.tools ?? [])],
  };
  showModal.value = true;
}

function closeModal() {
  showModal.value = false;
  editingAgent.value = null;
}

async function saveAgent() {
  if (!formData.value.name?.trim() || !formData.value.model?.trim() || !formData.value.workspacePath?.trim()) {
    return;
  }

  saving.value = true;
  try {
    const url = isEditing.value ? `/api/agents/${editingAgent.value!.id}` : '/api/agents';
    const method = isEditing.value ? 'POST' : 'POST';
    const body = isEditing.value 
      ? { id: editingAgent.value!.id, ...formData.value }
      : formData.value;

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    
    if (!res.ok) {
      throw new Error(`The agent couldn't be saved (server response ${res.status}). Try again.`);
    }
    closeModal();
    await loadAgents(false);
    showToast(isEditing.value ? 'Agent updated.' : 'Agent created.', 'success');
  } catch {
    showToast('The agent couldn\'t be saved. Check the server connection and try again.', 'error');
  } finally {
    saving.value = false;
  }
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
    showToast('The session couldn\'t be created. Check the server connection and try again.', 'error');
  } finally {
    startingId.value = null;
  }
}

async function deleteAgent(agent: AgentDTO) {
  if (!confirm(`Delete "${agent.name}"? This removes the agent configuration and cannot be undone.`)) return;

  deletingId.value = agent.id;
  try {
    const res = await fetch(`/api/agents/${agent.id}/delete`, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`The agent couldn't be deleted (server response ${res.status}). Try again.`);
    }
    await loadAgents(false);
  } catch {
    showToast('The agent couldn\'t be deleted. Check the server connection and try again.', 'error');
  } finally {
    deletingId.value = null;
  }
}

function toolsString(tools: string[]): string {
  return tools.join(', ');
}

function setToolsString(value: string) {
  formData.value.tools = value
    .split(',')
    .map((tool) => tool.trim())
    .filter(Boolean);
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
    <header class="page-heading">
      <div class="page-actions">
        <input
          v-model="searchQuery"
          type="text"
          class="control search-input"
          placeholder="Search agents..."
        />
        <button
          class="btn btn-primary btn-icon"
          type="button"
          title="New agent"
          @click="openCreateModal"
        >
          <AppIcon name="plus" :size="16" />
        </button>
        <span class="page-count">{{ filteredAgents.length }} {{ filteredAgents.length === 1 ? 'agent' : 'agents' }}</span>
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
    </header>

    <div class="surface-panel" :aria-busy="loading">
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
                <p class="resource-tools">Tools: {{ (agent.tools ?? []).join(', ') || '—' }}</p>
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

    <!-- Agent Modal -->
    <Teleport to="body">
      <div v-if="showModal" class="modal-backdrop" @click.self="closeModal">
        <div class="modal">
          <div class="modal-header">
            <h3>{{ modalTitle }}</h3>
            <button class="modal-close" @click="closeModal">×</button>
          </div>
          <form class="modal-body" @submit.prevent="saveAgent">
            <div class="form-grid">
              <label class="field">
                <span class="field-label">Name *</span>
                <input v-model="formData.name" class="control" autocomplete="off" required />
              </label>
              <label class="field">
                <span class="field-label">Model *</span>
                <select v-model="formData.model" class="control" required>
                  <option value="" disabled>Select model</option>
                  <option v-for="m in allModels" :key="`${m.provider}/${m.modelId}`" :value="`${m.provider}/${m.modelId}`">
                    {{ m.displayName }} ({{ m.provider }})
                  </option>
                </select>
              </label>
              <label class="field field-span-2">
                <span class="field-label">Description</span>
                <input v-model="formData.description" class="control" autocomplete="off" />
              </label>
              <label class="field field-span-2">
                <span class="field-label">Workspace path *</span>
                <input v-model="formData.workspacePath" class="control mono" autocomplete="off" required />
              </label>
              <label class="field field-span-2">
                <span class="field-label">System prompt</span>
                <textarea v-model="formData.systemPrompt" class="control" rows="4" />
              </label>
              <label class="field field-span-2">
                <span class="field-label">Append system prompt</span>
                <textarea v-model="formData.appendSystemPrompt" class="control" rows="4" />
              </label>
              <label class="field field-span-2">
                <span class="field-label">Tools (comma-separated)</span>
                <input
                  :value="toolsString(formData.tools)"
                  class="control mono"
                  autocomplete="off"
                  @input="(event: Event) => setToolsString((event.target as HTMLInputElement).value)"
                />
              </label>
            </div>
            <div class="modal-actions">
              <button type="button" class="btn btn-secondary" @click="closeModal">Cancel</button>
              <button type="submit" class="btn btn-primary" :disabled="saving">
                <AppIcon :name="saving ? 'refresh' : 'check'" :size="16" />
                {{ saving ? 'Saving...' : 'Save' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  background: var(--surface);
  border-radius: 12px;
  width: 90%;
  max-width: 560px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}

.modal-header h3 {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
}

.modal-close {
  background: transparent;
  border: none;
  font-size: 24px;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
  line-height: 1;
}

.modal-close:hover {
  color: var(--text);
}

.modal-body {
  padding: 20px;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-span-2 {
  grid-column: span 2;
}

.field-label {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-secondary);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
}
</style>
