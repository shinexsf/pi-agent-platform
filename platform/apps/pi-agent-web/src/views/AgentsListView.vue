<script setup lang="ts">
import { ref, onMounted, reactive } from 'vue';
import { useRouter } from 'vue-router';
import type { AgentDTO } from '@pi-agent-platform/shared-types';
import AppIcon from '../components/ui/AppIcon.vue';

const router = useRouter();
const agents = ref<AgentDTO[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const editingId = ref<string | null>(null);
const startingId = ref<string | null>(null);
const deletingId = ref<string | null>(null);
const savingId = ref<string | null>(null);

const editBuffers = reactive<Record<string, Partial<AgentDTO>>>({});

function showToast(message: string, variant: 'info' | 'success' | 'error' = 'info') {
  window.dispatchEvent(new CustomEvent('im-gateway:toast', { detail: { message, variant } }));
}

async function loadAgents(showLoading = true) {
  if (showLoading) loading.value = true;
  loadError.value = null;
  try {
    const res = await fetch('/api/agents');
    if (!res.ok) throw new Error(`Server response ${res.status}`);
    agents.value = await res.json();
  } catch {
    loadError.value = 'Check the server connection and try again.';
    if (agents.value.length > 0) {
      showToast(`Agents couldn't be refreshed. ${loadError.value}`, 'error');
    }
  } finally {
    loading.value = false;
  }
}

function startEdit(agent: AgentDTO) {
  editingId.value = agent.id;
  editBuffers[agent.id] = {
    name: agent.name,
    description: agent.description,
    model: agent.model,
    thinkingLevel: agent.thinkingLevel,
    systemPrompt: agent.systemPrompt,
    appendSystemPrompt: agent.appendSystemPrompt,
    tools: [...(agent.tools ?? [])],
    workspacePath: agent.workspacePath,
  };
}

function cancelEdit(id: string) {
  editingId.value = null;
  delete editBuffers[id];
}

async function saveEdit(id: string) {
  const buf = editBuffers[id];
  if (!buf) return;
  if (!buf.name?.trim() || !buf.model?.trim() || !buf.workspacePath?.trim()) {
    return;
  }

  savingId.value = id;
  try {
    const res = await fetch(`/api/agents/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buf),
    });
    if (!res.ok) {
      throw new Error(`The agent couldn't be updated (server response ${res.status}). Try again.`);
    }
    editingId.value = null;
    delete editBuffers[id];
    await loadAgents(false);
  } catch {
    showToast('The agent couldn\'t be updated. Check the server connection and try again.', 'error');
  } finally {
    savingId.value = null;
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
    await router.push(`/sessions/${data.sessionId}?agentId=${data.agentId}`);
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

function toolsString(tools: string[] | undefined): string {
  return (tools ?? []).join(', ');
}

function setToolsString(id: string, value: string) {
  const buf = editBuffers[id];
  if (!buf) return;
  buf.tools = value
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
      <div class="page-heading-copy">
        <h1 id="agents-title" class="page-title">Agents</h1>
      </div>
      <div class="page-actions">
        <router-link class="btn btn-secondary" to="/sessions">
          <AppIcon name="sessions" :size="16" />
          Sessions
        </router-link>
        <span class="page-count">{{ agents.length }} {{ agents.length === 1 ? 'agent' : 'agents' }}</span>
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

      <div v-else-if="agents.length === 0" class="state-panel">
        <div class="state-content">
          <span class="state-icon"><AppIcon name="agents" :size="23" /></span>
          <h2 class="state-title">No agents configured</h2>
        </div>
      </div>

      <ul v-else class="resource-list">
        <li v-for="agent in agents" :key="agent.id" class="resource-row">
          <div v-if="editingId !== agent.id" class="resource-row-inner">
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
              <button
                class="btn btn-primary"
                type="button"
                :class="{ 'is-loading': startingId === agent.id }"
                :disabled="startingId === agent.id || deletingId === agent.id"
                @click="startSession(agent.id)"
              >
                <AppIcon :name="startingId === agent.id ? 'refresh' : 'plus'" :size="16" />
                {{ startingId === agent.id ? '…' : 'New session' }}
              </button>
              <button
                class="btn btn-secondary"
                type="button"
                :aria-label="`Edit ${agent.name}`"
                @click="startEdit(agent)"
              >
                <AppIcon name="edit" :size="16" />
                Edit
              </button>
              <button
                class="btn btn-danger"
                type="button"
                :aria-label="`Delete ${agent.name}`"
                :disabled="deletingId === agent.id || startingId === agent.id"
                @click="deleteAgent(agent)"
              >
                <AppIcon name="trash" :size="16" />
                Delete
              </button>
            </div>
          </div>

          <form v-else class="inline-editor" @submit.prevent="saveEdit(agent.id)">
            <div class="form-grid">
              <label class="field">
                <span class="field-label">Name</span>
                <input v-model="editBuffers[agent.id]!.name" class="control" autocomplete="off" required />
              </label>
              <label class="field">
                <span class="field-label">Model</span>
                <input v-model="editBuffers[agent.id]!.model" class="control mono" autocomplete="off" required />
              </label>
              <label class="field field-span-2">
                <span class="field-label">Description</span>
                <input
                  v-model="editBuffers[agent.id]!.description"
                  class="control"
                  autocomplete="off"
                />
              </label>
              <label class="field field-span-2">
                <span class="field-label">Workspace path</span>
                <input v-model="editBuffers[agent.id]!.workspacePath" class="control mono" autocomplete="off" required />
              </label>
              <label class="field field-span-2">
                <span class="field-label">System prompt</span>
                <textarea
                  v-model="editBuffers[agent.id]!.systemPrompt"
                  class="control"
                  rows="4"
                />
              </label>
              <label class="field field-span-2">
                <span class="field-label">Tools (comma-separated)</span>
                <input
                  :value="toolsString(editBuffers[agent.id]!.tools)"
                  class="control mono"
                  autocomplete="off"
                  @input="(event: Event) => setToolsString(agent.id, (event.target as HTMLInputElement).value)"
                />
              </label>
            </div>
            <div class="editor-actions">
              <button
                class="btn btn-secondary"
                type="button"
                :disabled="savingId === agent.id"
                @click="cancelEdit(agent.id)"
              >
                Cancel
              </button>
              <button
                class="btn btn-primary"
                type="submit"
                :class="{ 'is-loading': savingId === agent.id }"
                :disabled="savingId === agent.id"
              >
                <AppIcon :name="savingId === agent.id ? 'refresh' : 'check'" :size="16" />
                {{ savingId === agent.id ? '…' : 'Save' }}
              </button>
            </div>
          </form>
        </li>
      </ul>
    </div>
  </section>
</template>
