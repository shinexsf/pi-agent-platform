<script setup lang="ts">
/**
 * QqChannelsPage.vue — list + create flow (no QR for QQ — appId/appSecret required).
 *
 * Default UX: prominent "🤖 创建 QQ 机器人" button → dialog (displayName, agentId, appId, appSecret)
 *   → server creates row + auto-starts WebSocket → events shown inline
 */
import { ref, onMounted, computed } from 'vue';
import { createQqApi, type QqChannel } from './api';
import QrLoginDialog from './QrLoginDialog.vue';

declare global {
  interface Window {
    __channelAdminHost?: import('@pi-agent-platform/channel-types').ChannelAdminHost;
  }
}

const channels = ref<QqChannel[]>([]);
const agents = ref<AgentRow[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const showCreate = ref(false);
const editingChannelId = ref<string | null>(null);
const editingAgentId = ref<string>('');

const host = computed(() => window.__channelAdminHost);
const api = computed(() => (host.value ? createQqApi(host.value) : null));

const agentNameById = computed(() => {
  const m = new Map<string, string>();
  for (const a of agents.value) m.set(a.id, a.name);
  return m;
});

function agentLabel(agentId?: string | null): string {
  if (!agentId) return '—';
  return agentNameById.value.get(agentId) ?? `${agentId.slice(0, 8)}…`;
}

async function loadAgents(): Promise<void> {
  try {
    // /api/agents is top-level (not under /api/im/<type>/), so use raw fetch
    // instead of host.apiFetch (which prefixes with /api/im/<type>).
    const res = await fetch('/api/agents');
    if (!res.ok) throw new Error(`/api/agents returned ${res.status}`);
    const list = (await res.json()) as AgentRow[] | { agents?: AgentRow[] };
    if (Array.isArray(list)) agents.value = list;
    else if (list && Array.isArray((list as { agents?: AgentRow[] }).agents))
      agents.value = (list as { agents?: AgentRow[] }).agents ?? [];
  } catch (err) {
    console.warn('[qq-page] failed to load agents', err);
  }
}

async function refresh(): Promise<void> {
  if (!api.value) return;
  loading.value = true;
  error.value = null;
  try {
    channels.value = await api.value.list();
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function handleStart(id: string): Promise<void> {
  if (!api.value || !host.value) return;
  try {
    await api.value.start(id);
    host.value.showToast({ message: 'Start requested', variant: 'info' });
    await refresh();
  } catch (e) {
    host.value.showToast({ message: `Start failed: ${String(e)}`, variant: 'error' });
  }
}

async function handleStop(id: string): Promise<void> {
  if (!api.value || !host.value) return;
  try {
    await api.value.stop(id);
    host.value.showToast({ message: 'Stopped', variant: 'info' });
    await refresh();
  } catch (e) {
    host.value.showToast({ message: `Stop failed: ${String(e)}`, variant: 'error' });
  }
}

async function handleDelete(id: string, name: string): Promise<void> {
  if (!api.value || !host.value) return;
  const ok = await host.value.showConfirmDialog({
    title: 'Delete Channel',
    message: `Delete "${name}"?`,
    confirmText: 'Delete',
    destructive: true,
  });
  if (!ok) return;
  try {
    await api.value.remove(id);
    await refresh();
    host.value.showToast({ message: 'Deleted', variant: 'info' });
  } catch (e) {
    host.value.showToast({ message: `Delete failed: ${String(e)}`, variant: 'error' });
  }
}

onMounted(async () => {
  await Promise.all([refresh(), loadAgents()]);
});

function openAgentEditor(ch: QqChannel): void {
  editingChannelId.value = ch.id;
  editingAgentId.value = ch.defaultAgentId ?? '';
}

async function saveAgentEditor(): Promise<void> {
  if (!api.value || !host.value || !editingChannelId.value) return;
  const id = editingChannelId.value;
  const newAgentId = editingAgentId.value;
  if (!newAgentId) {
    host.value.showToast({ message: '请选择一个 Agent', variant: 'error' });
    return;
  }
  try {
    await api.value.update(id, { defaultAgentId: newAgentId });
    host.value.showToast({ message: 'Agent 已更新,后续消息使用新 Agent', variant: 'success' });
    editingChannelId.value = null;
    await refresh();
  } catch (e) {
    host.value.showToast({ message: `Update failed: ${String(e)}`, variant: 'error' });
  }
}
</script>

<template>
  <div class="qq-channels-page">
    <header class="page-header">
      <h2>QQ Channels</h2>
      <p class="hint">⚠️ MVP 仅支持私聊 (C2C)。群聊消息会被 fast-fail。</p>
    </header>

    <section v-if="error" class="error">{{ error }}</section>

    <!-- Create CTA -->
    <section class="qr-login-cta">
      <button class="btn-qr-login" @click="showCreate = true">
        🤖 创建 QQ 机器人
      </button>
      <p class="cta-hint">
        点击按钮 → 填写 displayName + agentId → 弹 QR → 用<b>手机 QQ</b>扫码 → 在手机上点授权 → 自动入库并启动
      </p>
    </section>

    <section class="channel-list">
      <h3>Channels ({{ channels.length }})</h3>
      <div v-if="loading">Loading...</div>
      <div v-else-if="channels.length === 0" class="empty">
        还没有 channel。点击顶部"创建 QQ 机器人"按钮开始。
      </div>
      <table v-else>
        <thead>
          <tr>
            <th>Name</th>
            <th>Agent</th>
            <th>App ID</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ch in channels" :key="ch.id">
            <td>{{ ch.displayName }}</td>
            <td>
              <button class="link" @click="openAgentEditor(ch)" :title="ch.defaultAgentId">
                {{ agentLabel(ch.defaultAgentId) }} <span class="edit-icon">✎</span>
              </button>
            </td>
            <td><code>{{ ch.appId?.slice(0, 12) ?? ch.extra?.appId?.slice(0, 12) ?? '—' }}…</code></td>
            <td>
              <button @click="handleStart(ch.id)">Start</button>
              <button @click="handleStop(ch.id)">Stop</button>
              <button class="danger" @click="handleDelete(ch.id, ch.displayName)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- Change Agent modal -->
    <div v-if="editingChannelId" class="modal-backdrop" @click.self="editingChannelId = null">
      <div class="modal">
        <h3>更改 Agent</h3>
        <p class="hint">选择新 Agent 后,当前会话 worker 会被杀掉,下一条消息使用新 Agent 处理。</p>
        <select v-model="editingAgentId">
          <option value="" disabled>选择 Agent</option>
          <option v-for="a in agents" :key="a.id" :value="a.id">
            {{ a.name }} — {{ a.model }}
          </option>
        </select>
        <div class="modal-actions">
          <button @click="editingChannelId = null">取消</button>
          <button class="primary" @click="saveAgentEditor">保存</button>
        </div>
      </div>
    </div>

    <QrLoginDialog
      v-if="showCreate"
      v-model:open="showCreate"
      channel-type="qq"
      @connected="refresh"
    />
  </div>
</template>

<style scoped>
.qq-channels-page { padding: 16px; }
.page-header { margin-bottom: 16px; }
.page-header h2 { margin: 0; }
.hint { color: #f59e0b; font-size: 14px; margin: 4px 0 0; }
.error { background: #fee; color: #c00; padding: 12px; border-radius: 6px; margin-bottom: 16px; }

.qr-login-cta {
  background: linear-gradient(135deg, #ddd6fe 0%, #ede9fe 100%);
  border: 2px solid #8b5cf6;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 16px;
  text-align: center;
}
.btn-qr-login {
  background: #8b5cf6;
  color: white;
  border: none;
  padding: 14px 28px;
  font-size: 16px;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
}
.btn-qr-login:hover { background: #7c3aed; transform: translateY(-1px); }
.cta-hint { color: #5b21b6; font-size: 13px; margin: 12px 0 0; }

.channel-list { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; }
.channel-list h3 { margin: 0 0 12px; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 8px; text-align: left; border-bottom: 1px solid #e5e7eb; }
button { padding: 6px 12px; border: 1px solid #d1d5db; background: #fff; border-radius: 4px; cursor: pointer; margin-right: 4px; }
button:hover { background: #f9fafb; }
button.link { background: transparent; border: 1px dashed #c4b5fd; color: #6d28d9; padding: 4px 10px; }
button.link:hover { background: #f5f3ff; border-style: solid; }
button.primary { background: #8b5cf6; color: white; border-color: #8b5cf6; }
button.primary:hover { background: #7c3aed; }
.edit-icon { font-size: 11px; margin-left: 4px; opacity: 0.7; }

.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: white; border-radius: 8px; padding: 24px; max-width: 480px; width: 90%; }
.modal h3 { margin: 0 0 8px; }
.modal .hint { color: #6b7280; font-size: 13px; margin: 0 0 16px; }
.modal select { width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
button.danger { color: #c00; border-color: #c00; }
.empty { color: #9ca3af; padding: 24px; text-align: center; }
</style>