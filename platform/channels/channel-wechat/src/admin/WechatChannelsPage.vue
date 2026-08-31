<script setup lang="ts">
/**
 * WechatChannelsPage.vue — list + QR-login flow + manual create (advanced).
 *
 * Default UX: prominent "📱 扫码登录新机器人" button at the top.
 *   1. Click button → dialog opens with a setup form (displayName, agentId)
 *   2. Submit → server creates row + auto-assigns storageDir → returns channelId
 *   3. Dialog subscribes to SSE filtered by channelId, then calls /start-qr
 *   4. SDK emits 'qr-url' → dialog shows QR image
 *   5. User scans with iOS WeChat → 'connected' event → dialog auto-closes
 *
 * Advanced users can still create rows manually via the collapsed form.
 */
import { ref, onMounted, computed } from 'vue';
import { createWechatApi, type WechatChannel } from './api';
import QrLoginDialog from './QrLoginDialog.vue';

interface AgentRow {
  id: string;
  name: string;
  description?: string;
  model: string;
}

declare global {
  interface Window {
    __channelAdminHost?: import('@pi-agent-platform/channel-types').ChannelAdminHost;
  }
}

const channels = ref<WechatChannel[]>([]);
const agents = ref<AgentRow[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const newChannel = ref({ displayName: '', defaultAgentId: '', storageDir: '' });

const showQrLogin = ref(false);
const showManualCreate = ref(false);
const editingChannelId = ref<string | null>(null);
const editingAgentId = ref<string>('');

const host = computed(() => window.__channelAdminHost);
const api = computed(() => (host.value ? createWechatApi(host.value) : null));

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
    // /api/agents is top-level (not under /api/im/<type>/), so use raw fetch.
    // Be permissive — any failure leaves the list empty.
    const res = await fetch('/api/agents').catch(() => null);
    if (res && typeof res.ok === 'boolean' && res.ok) {
      const list = (await res.json().catch(() => [])) as AgentRow[] | { agents?: AgentRow[] };
      if (Array.isArray(list)) agents.value = list;
      else if (list && Array.isArray((list as { agents?: AgentRow[] }).agents))
        agents.value = (list as { agents?: AgentRow[] }).agents ?? [];
    }
  } catch (err) {
    console.warn('[wechat-page] failed to load agents', err);
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

async function handleManualCreate(): Promise<void> {
  if (!api.value || !host.value) return;
  if (!newChannel.value.displayName || !newChannel.value.defaultAgentId || !newChannel.value.storageDir) {
    error.value = 'All fields are required';
    return;
  }
  try {
    await api.value.create(newChannel.value);
    newChannel.value = { displayName: '', defaultAgentId: '', storageDir: '' };
    showManualCreate.value = false;
    await refresh();
    host.value.showToast({ message: 'Channel created', variant: 'success' });
  } catch (e) {
    error.value = String(e);
  }
}

async function handleStart(id: string): Promise<void> {
  if (!api.value || !host.value) return;
  try {
    await api.value.start(id);
    host.value.showToast({ message: 'Start requested (watch channel for status)', variant: 'info' });
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
    message: `Delete "${name}"? This will stop the adapter and remove the row.`,
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

function openAgentEditor(ch: WechatChannel): void {
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

onMounted(async () => {
  await Promise.all([refresh(), loadAgents()]);
});
</script>

<template>
  <div class="wechat-channels-page">
    <header class="page-header">
      <h2>WeChat Channels</h2>
      <p class="hint">⚠️ WeChat iLink ClawBot 仅支持 iOS 客户端扫码登录</p>
    </header>

    <section v-if="error" class="error">{{ error }}</section>

    <!-- QR login: prominent default flow -->
    <section class="qr-login-cta">
      <button class="btn-qr-login" @click="showQrLogin = true">
        📱 扫码登录新微信机器人
      </button>
      <p class="cta-hint">
        点击按钮 → 填写 displayName 和 defaultAgentId → 弹 QR → 用 iOS 微信扫码 → 自动入库并启动
      </p>
    </section>

    <!-- Manual create (advanced) — collapsed by default -->
    <details class="manual-section">
      <summary @click.prevent="showManualCreate = !showManualCreate">
        ⚙️ 高级:手动创建(已有 iOS ClawBot 凭据)
      </summary>
      <div v-if="showManualCreate" class="manual-form">
        <div class="row">
          <input v-model="newChannel.displayName" placeholder="Display Name" />
          <input v-model="newChannel.defaultAgentId" placeholder="Default Agent ID" />
          <input v-model="newChannel.storageDir" placeholder="Storage Directory (绝对路径)" />
          <button @click="handleManualCreate">Create</button>
        </div>
      </div>
    </details>

    <section class="channel-list">
      <h3>Channels ({{ channels.length }})</h3>
      <div v-if="loading">Loading...</div>
      <div v-else-if="channels.length === 0" class="empty">
        还没有 channel。点击顶部"扫码登录新微信机器人"按钮开始。
      </div>
      <table v-else>
        <thead>
          <tr>
            <th>Name</th>
            <th>Agent</th>
            <th>Storage</th>
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
            <td><code>{{ ch.storageDir ?? ch.extra?.storageDir ?? '—' }}</code></td>
            <td>
              <button @click="handleStart(ch.id)">Start</button>
              <button @click="handleStop(ch.id)">Stop</button>
              <button class="danger" @click="handleDelete(ch.id, ch.displayName)">Delete</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- QR Login Dialog -->
    <QrLoginDialog
      v-if="showQrLogin"
      v-model:open="showQrLogin"
      channel-type="wechat"
      @connected="refresh"
    />

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
  </div>
</template>

<style scoped>
.wechat-channels-page { padding: 16px; }
.page-header { margin-bottom: 16px; }
.page-header h2 { margin: 0; }
.hint { color: #f59e0b; font-size: 14px; margin: 4px 0 0; }
.error { background: #fee; color: #c00; padding: 12px; border-radius: 6px; margin-bottom: 16px; }

/* QR login CTA — prominent */
.qr-login-cta {
  background: linear-gradient(135deg, #dbeafe 0%, #eff6ff 100%);
  border: 2px solid #3b82f6;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 16px;
  text-align: center;
}
.btn-qr-login {
  background: #3b82f6;
  color: white;
  border: none;
  padding: 14px 28px;
  font-size: 16px;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.btn-qr-login:hover {
  background: #2563eb;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(59, 130, 246, 0.3);
}
.cta-hint {
  color: #1e40af;
  font-size: 13px;
  margin: 12px 0 0;
}

/* Manual create — collapsed */
.manual-section {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 16px;
}
.manual-section summary {
  cursor: pointer;
  font-size: 13px;
  color: #6b7280;
  user-select: none;
}
.manual-section summary:hover { color: #111827; }
.manual-form { margin-top: 12px; }
.manual-form .row {
  display: flex; gap: 8px; align-items: center;
}
.manual-form input { flex: 1; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; }

.channel-list { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; }
.channel-list h3 { margin: 0 0 12px; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 8px; text-align: left; border-bottom: 1px solid #e5e7eb; }
button { padding: 6px 12px; border: 1px solid #d1d5db; background: #fff; border-radius: 4px; cursor: pointer; margin-right: 4px; }
button:hover { background: #f9fafb; }
button.danger { color: #c00; border-color: #c00; }
button.link { background: transparent; border: 1px dashed #93c5fd; color: #1d4ed8; padding: 4px 10px; }
button.link:hover { background: #eff6ff; border-style: solid; }
button.primary { background: #3b82f6; color: white; border-color: #3b82f6; }
button.primary:hover { background: #2563eb; }
.edit-icon { font-size: 11px; margin-left: 4px; opacity: 0.7; }
.empty { color: #9ca3af; padding: 24px; text-align: center; }

.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: white; border-radius: 8px; padding: 24px; max-width: 480px; width: 90%; }
.modal h3 { margin: 0 0 8px; }
.modal .hint { color: #6b7280; font-size: 13px; margin: 0 0 16px; }
.modal select { width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
</style>