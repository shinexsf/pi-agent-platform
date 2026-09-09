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
const channelStatus = ref<Record<string, string>>({});
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
    const [list, statusMap] = await Promise.all([api.value.list(), api.value.listStatus()]);
    channels.value = list;
    channelStatus.value = statusMap;
  } catch {
    error.value = '无法加载 QQ 机器人。请检查服务连接并刷新页面重试。';
  } finally {
    loading.value = false;
  }
}

function getStatus(id: string): string {
  return channelStatus.value[id] ?? 'unknown';
}

async function handleStart(id: string): Promise<void> {
  if (!api.value || !host.value) return;
  try {
    await api.value.start(id);
    host.value.showToast({ message: '启动请求已发送。', variant: 'info' });
    await refresh();
  } catch {
    host.value.showToast({ message: '无法启动 QQ 机器人。请检查渠道配置后重试。', variant: 'error' });
  }
}

async function handleStop(id: string): Promise<void> {
  if (!api.value || !host.value) return;
  try {
    await api.value.stop(id);
    host.value.showToast({ message: 'QQ 机器人已停止。', variant: 'info' });
    await refresh();
  } catch {
    host.value.showToast({ message: '无法停止 QQ 机器人。请稍后重试。', variant: 'error' });
  }
}

async function handleDelete(id: string, name: string): Promise<void> {
  if (!api.value || !host.value) return;
  const ok = await host.value.showConfirmDialog({
    title: '删除 QQ 机器人？',
    message: `删除“${name}”后，该机器人会停止运行，渠道配置也会被永久移除。`,
    confirmText: '删除',
    cancelText: '取消',
    destructive: true,
  });
  if (!ok) return;
  try {
    await api.value.remove(id);
    await refresh();
    host.value.showToast({ message: 'QQ 机器人已删除。', variant: 'info' });
  } catch {
    host.value.showToast({ message: '无法删除 QQ 机器人。请稍后重试。', variant: 'error' });
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
    host.value.showToast({ message: '默认 Agent 已更新。后续消息将由新 Agent 处理。', variant: 'success' });
    editingChannelId.value = null;
    await refresh();
  } catch {
    host.value.showToast({ message: '无法更新默认 Agent。请稍后重试。', variant: 'error' });
  }
}
</script>

<template>
  <div class="qq-channels-page">
    <header class="page-header">
      <h2>QQ 机器人</h2>
      <p class="hint">当前版本仅支持 QQ 私聊（C2C），群聊消息不会被处理。</p>
    </header>

    <section v-if="error" class="error">{{ error }}</section>

    <!-- Create CTA -->
    <section class="qr-login-cta">
      <button class="btn-qr-login" @click="showCreate = true">
        扫码添加 QQ 机器人
      </button>
      <p class="cta-hint">
        选择默认 Agent，然后使用手机 QQ 扫描二维码并完成授权。机器人会自动创建并启动。
      </p>
    </section>

    <section class="channel-list">
      <h3>QQ 机器人（{{ channels.length }}）</h3>
      <div v-if="loading">正在加载 QQ 机器人…</div>
      <div v-else-if="channels.length === 0" class="empty">
        还没有 QQ 机器人。点击上方“扫码添加 QQ 机器人”开始配置。
      </div>
      <table v-else>
        <thead>
          <tr>
            <th>状态</th>
            <th>名称</th>
            <th>Agent</th>
            <th>App ID</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ch in channels" :key="ch.id">
            <td>
              <span class="status-dot" :class="getStatus(ch.id) === 'connected' ? 'status-connected' : 'status-stopped'" :title="getStatus(ch.id)"></span>
            </td>
            <td>{{ ch.displayName }}</td>
            <td>
              <button class="link" @click="openAgentEditor(ch)" :title="ch.defaultAgentId">
                {{ agentLabel(ch.defaultAgentId) }} <span class="edit-label">更改</span>
              </button>
            </td>
            <td><code>{{ ch.appId?.slice(0, 12) ?? ch.extra?.appId?.slice(0, 12) ?? '—' }}…</code></td>
            <td>
              <button v-if="getStatus(ch.id) !== 'connected'" @click="handleStart(ch.id)">启动</button>
              <button v-else @click="handleStop(ch.id)">停止</button>
              <button class="danger" @click="handleDelete(ch.id, ch.displayName)">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- Change Agent modal -->
    <div v-if="editingChannelId" class="modal-backdrop" @click.self="editingChannelId = null">
      <div class="modal">
        <h3>更改 Agent</h3>
        <p class="hint">更改后，当前会话进程将停止；收到下一条消息时，系统会使用新 Agent 启动会话。</p>
        <label class="modal-field">
          <span>默认 Agent</span>
          <select v-model="editingAgentId">
            <option value="" disabled>选择 Agent</option>
            <option v-for="a in agents" :key="a.id" :value="a.id">
              {{ a.name }} — {{ a.model }}
            </option>
          </select>
        </label>
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
.edit-label { font-size: 11px; margin-left: 4px; opacity: 0.7; }

.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: white; border-radius: 8px; padding: 24px; max-width: 480px; width: 90%; }
.modal h3 { margin: 0 0 8px; }
.modal .hint { color: #6b7280; font-size: 13px; margin: 0 0 16px; }
.modal-field { display: grid; gap: 5px; color: #4b5563; font-size: 13px; }
.modal select { width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
button.danger { color: #c00; border-color: #c00; }
.empty { color: #9ca3af; padding: 24px; text-align: center; }

.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.status-connected { background: #22c55e; }
.status-stopped { background: #ef4444; }
</style>
