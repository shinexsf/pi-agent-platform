<script setup lang="ts">
import { ref, onMounted, reactive } from 'vue';
import { useRouter } from 'vue-router';
import type { AgentDTO } from '@pi-agent-platform/shared-types';

const router = useRouter();
const agents = ref<AgentDTO[]>([]);
const loading = ref(true);
const editingId = ref<string | null>(null);
const startingId = ref<string | null>(null);
const deletingId = ref<string | null>(null);

// Inline edit buffer — keyed by agent id.
const editBuffers = reactive<Record<string, Partial<AgentDTO>>>({});

async function loadAgents() {
  try {
    const res = await fetch('/api/agents');
    if (res.ok) agents.value = await res.json();
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
  const res = await fetch(`/api/agents/${id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buf),
  });
  if (!res.ok) {
    alert(`Update failed: ${res.status}`);
    return;
  }
  editingId.value = null;
  delete editBuffers[id];
  await loadAgents();
}

async function startSession(agentId: string) {
  startingId.value = agentId;
  try {
    const res = await fetch(`/api/sessions/agents/${agentId}`, { method: 'POST' });
    if (!res.ok) {
      alert(`Failed to create session: ${res.status}`);
      return;
    }
    const data = (await res.json()) as { sessionId: string; agentId: string };
    router.push(`/sessions/${data.sessionId}?agentId=${data.agentId}`);
  } finally {
    startingId.value = null;
  }
}

async function deleteAgent(id: string) {
  if (!confirm('Delete this agent?')) return;
  deletingId.value = id;
  try {
    const res = await fetch(`/api/agents/${id}/delete`, { method: 'POST' });
    if (!res.ok) {
      alert(`Delete failed: ${res.status}`);
      return;
    }
    await loadAgents();
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
    .map((s) => s.trim())
    .filter(Boolean);
}

onMounted(loadAgents);
</script>

<template>
  <div class="max-w-3xl">
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-2xl font-bold">Agents</h2>
      <div class="flex gap-2 items-center">
        <router-link
          to="/sessions"
          class="text-xs px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          📋 Sessions
        </router-link>
        <span class="text-xs text-gray-500">{{ agents.length }} total</span>
      </div>
    </div>

    <div v-if="loading" class="text-gray-500">Loading...</div>
    <div v-else-if="agents.length === 0" class="text-gray-500">No agents yet.</div>

    <ul v-else class="space-y-2">
      <li
        v-for="agent in agents"
        :key="agent.id"
        class="p-3 rounded border border-gray-200 dark:border-gray-700"
      >
        <!-- View mode -->
        <div v-if="editingId !== agent.id" class="flex items-start justify-between gap-3">
          <div class="flex-1 min-w-0">
            <div class="font-medium">{{ agent.name }}</div>
            <div class="text-xs text-gray-500 truncate">{{ agent.model }} · {{ agent.workspacePath }}</div>
            <div v-if="agent.description" class="text-xs text-gray-400 mt-1">{{ agent.description }}</div>
            <div class="text-[10px] text-gray-400 mt-1">tools: {{ (agent.tools ?? []).join(', ') || '—' }}</div>
          </div>
          <div class="flex flex-col gap-1 shrink-0">
            <button
              class="px-3 py-1 text-xs rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
              :disabled="startingId === agent.id"
              @click="startSession(agent.id)"
            >
              {{ startingId === agent.id ? '…' : '▶ New session' }}
            </button>
            <button
              class="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
              @click="startEdit(agent)"
            >
              ✎ Edit
            </button>
            <button
              class="px-3 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-900 disabled:opacity-50"
              :disabled="deletingId === agent.id"
              @click="deleteAgent(agent.id)"
            >
              🗑 Delete
            </button>
          </div>
        </div>

        <!-- Edit mode -->
        <div v-else class="space-y-2">
          <div class="grid grid-cols-2 gap-2">
            <label class="text-xs">
              <span class="text-gray-500">Name</span>
              <input
                v-model="editBuffers[agent.id]!.name"
                class="w-full p-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
              />
            </label>
            <label class="text-xs">
              <span class="text-gray-500">Model</span>
              <input
                v-model="editBuffers[agent.id]!.model"
                class="w-full p-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
              />
            </label>
          </div>
          <label class="text-xs block">
            <span class="text-gray-500">Description</span>
            <input
              v-model="editBuffers[agent.id]!.description"
              class="w-full p-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
            />
          </label>
          <label class="text-xs block">
            <span class="text-gray-500">Workspace path</span>
            <input
              v-model="editBuffers[agent.id]!.workspacePath"
              class="w-full p-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
            />
          </label>
          <label class="text-xs block">
            <span class="text-gray-500">System prompt</span>
            <textarea
              v-model="editBuffers[agent.id]!.systemPrompt"
              rows="2"
              class="w-full p-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
            />
          </label>
          <label class="text-xs block">
            <span class="text-gray-500">Tools (comma-separated)</span>
            <input
              :value="toolsString(editBuffers[agent.id]!.tools)"
              class="w-full p-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900"
              @input="(e: Event) => setToolsString(agent.id, (e.target as HTMLInputElement).value)"
            />
          </label>
          <div class="flex justify-end gap-2">
            <button
              class="px-3 py-1 text-xs rounded border border-gray-300 dark:border-gray-600"
              @click="cancelEdit(agent.id)"
            >
              Cancel
            </button>
            <button
              class="px-3 py-1 text-xs rounded bg-blue-500 text-white"
              @click="saveEdit(agent.id)"
            >
              Save
            </button>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>