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
  } catch {
    error.value = '无法加载微信机器人。请检查服务连接并刷新页面重试。';
  } finally {
    loading.value = false;
  }
}

async function handleManualCreate(): Promise<void> {
  if (!api.value || !host.value) return;
  if (!newChannel.value.displayName || !newChannel.value.defaultAgentId || !newChannel.value.storageDir) {
    error.value = '请填写机器人名称、默认 Agent 和存储目录。';
    return;
  }
  try {
    await api.value.create(newChannel.value);
    newChannel.value = { displayName: '', defaultAgentId: '', storageDir: '' };
    showManualCreate.value = false;
    await refresh();
    host.value.showToast({ message: '微信机器人已创建。', variant: 'success' });
  } catch {
    error.value = '无法创建微信机器人。请检查填写内容后重试。';
  }
}

async function handleStart(id: string): Promise<void> {
  if (!api.value || !host.value) return;
  try {
    await api.value.start(id);
    host.value.showToast({ message: '启动请求已发送。', variant: 'info' });
    await refresh();
  } catch {
    host.value.showToast({ message: '无法启动微信机器人。请检查渠道配置后重试。', variant: 'error' });
  }
}

async function handleStop(id: string): Promise<void> {
  if (!api.value || !host.value) return;
  try {
    await api.value.stop(id);
    host.value.showToast({ message: '微信机器人已停止。', variant: 'info' });
    await refresh();
  } catch {
    host.value.showToast({ message: '无法停止微信机器人。请稍后重试。', variant: 'error' });
  }
}

async function handleDelete(id: string, name: string): Promise<void> {
  if (!api.value || !host.value) return;
  const ok = await host.value.showConfirmDialog({
    title: '删除微信机器人？',
    message: `删除“${name}”后，该机器人会停止运行，渠道配置也会被永久移除。`,
    confirmText: '删除',
    cancelText: '取消',
    destructive: true,
  });
  if (!ok) return;
  try {
    await api.value.remove(id);
    await refresh();
    host.value.showToast({ message: '微信机器人已删除。', variant: 'info' });
  } catch {
    host.value.showToast({ message: '无法删除微信机器人。请稍后重试。', variant: 'error' });
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
    host.value.showToast({ message: '默认 Agent 已更新。后续消息将由新 Agent 处理。', variant: 'success' });
    editingChannelId.value = null;
    await refresh();
  } catch {
    host.value.showToast({ message: '无法更新默认 Agent。请稍后重试。', variant: 'error' });
  }
}

onMounted(async () => {
  await Promise.all([refresh(), loadAgents()]);
});
</script>

<template>
  <div class="wechat-channels-page">
    <header class="page-header">
      <h2>微信机器人</h2>
      <p class="hint">WeChat iLink ClawBot 目前仅支持通过 iOS 微信扫码登录。</p>
    </header>

    <section v-if="error" class="error">{{ error }}</section>

    <!-- QR login: prominent default flow -->
    <section class="qr-login-cta">
      <button class="btn-qr-login" @click="showQrLogin = true">
        扫码添加微信机器人
      </button>
      <p class="cta-hint">
        填写机器人名称并选择默认 Agent，然后使用 iOS 微信扫描二维码。授权完成后，机器人会自动创建并启动。
      </p>
    </section>

    <!-- Manual create (advanced) — collapsed by default -->
    <details class="manual-section">
      <summary @click.prevent="showManualCreate = !showManualCreate">
        高级设置：使用现有 iOS ClawBot 凭据手动创建
      </summary>
      <div v-if="showManualCreate" class="manual-form">
        <div class="row">
          <label>
            <span>机器人名称</span>
            <input v-model="newChannel.displayName" placeholder="例如：客服小助手" />
          </label>
          <label>
            <span>默认 Agent ID</span>
            <input v-model="newChannel.defaultAgentId" placeholder="输入 Agent ID" />
          </label>
          <label>
            <span>存储目录</span>
            <input v-model="newChannel.storageDir" placeholder="输入绝对路径" />
          </label>
          <button @click="handleManualCreate">创建</button>
        </div>
      </div>
    </details>

    <section class="channel-list">
      <h3>微信机器人（{{ channels.length }}）</h3>
      <div v-if="loading">正在加载微信机器人…</div>
      <div v-else-if="channels.length === 0" class="empty">
        还没有微信机器人。点击上方“扫码添加微信机器人”开始配置。
      </div>
      <table v-else>
        <thead>
          <tr>
            <th>名称</th>
            <th>Agent</th>
            <th>存储目录</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ch in channels" :key="ch.id">
            <td>{{ ch.displayName }}</td>
            <td>
              <button class="link" @click="openAgentEditor(ch)" :title="ch.defaultAgentId">
                {{ agentLabel(ch.defaultAgentId) }} <span class="edit-label">更改</span>
              </button>
            </td>
            <td><code>{{ ch.storageDir ?? ch.extra?.storageDir ?? '—' }}</code></td>
            <td>
              <button @click="handleStart(ch.id)">启动</button>
              <button @click="handleStop(ch.id)">停止</button>
              <button class="danger" @click="handleDelete(ch.id, ch.displayName)">删除</button>
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
.manual-form label { display: grid; flex: 1; gap: 5px; color: #4b5563; font-size: 12px; }
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
.edit-label { font-size: 11px; margin-left: 4px; opacity: 0.7; }
.empty { color: #9ca3af; padding: 24px; text-align: center; }

.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal { background: white; border-radius: 8px; padding: 24px; max-width: 480px; width: 90%; }
.modal h3 { margin: 0 0 8px; }
.modal .hint { color: #6b7280; font-size: 13px; margin: 0 0 16px; }
.modal-field { display: grid; gap: 5px; color: #4b5563; font-size: 13px; }
.modal select { width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; }
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
</style>
