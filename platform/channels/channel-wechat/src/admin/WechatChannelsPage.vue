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

interface SessionRow {
  id: string;
  title?: string;
  agentId: string;
}

declare global {
  interface Window {
    __channelAdminHost?: import('@pi-agent-platform/channel-types').ChannelAdminHost;
  }
}

const channels = ref<WechatChannel[]>([]);
const channelStatus = ref<Record<string, string>>({});
const agents = ref<AgentRow[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const newChannel = ref({ displayName: '', defaultAgentId: '', storageDir: '' });

const showQrLogin = ref(false);
const editingChannelId = ref<string | null>(null);
const editingAgentId = ref<string>('');
const editingSessionId = ref<string | null>(null);
const sessions = ref<Array<{ id: string; title?: string; agentId: string }>>([]);

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

async function loadSessions(agentId?: string): Promise<void> {
  try {
    const url = agentId ? `/api/sessions?agent_id=${agentId}` : '/api/sessions';
    const res = await fetch(url).catch(() => null);
    if (res && typeof res.ok === 'boolean' && res.ok) {
      const data = await res.json().catch(() => ({ sessions: [] }));
      sessions.value = data.sessions ?? [];
    }
  } catch (err) {
    console.warn('[wechat-page] failed to load sessions', err);
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
    error.value = '无法加载微信机器人。请检查服务连接并刷新页面重试。';
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

function openSessionEditor(ch: WechatChannel): void {
  editingChannelId.value = ch.id;
  editingSessionId.value = ch.currentSessionId ?? '';
  // Load sessions for this agent
  loadSessions(ch.defaultAgentId);
}

async function saveSessionEditor(): Promise<void> {
  if (!api.value || !host.value || !editingChannelId.value) return;
  const id = editingChannelId.value;
  const newSessionId = editingSessionId.value;
  try {
    await api.value.update(id, { currentSessionId: newSessionId || undefined });
    host.value.showToast({ message: '当前会话已更新。', variant: 'success' });
    editingChannelId.value = null;
    editingSessionId.value = null;
    await refresh();
  } catch {
    host.value.showToast({ message: '无法更新当前会话。请稍后重试。', variant: 'error' });
  }
}

function sessionLabel(sessionId?: string | null): string {
  if (!sessionId) return '—';
  const session = sessions.value.find(s => s.id === sessionId);
  return session?.title ?? `${sessionId.slice(0, 8)}…`;
}

onMounted(async () => {
  await Promise.all([refresh(), loadAgents(), loadSessions()]);
});
</script>

<template>
  <div class="wechat-channels-page">
    <header class="page-header">
      <h2>微信机器人</h2>
      <p class="hint">WeChat iLink ClawBot 通过扫码登录。</p>
    </header>

    <section v-if="error" class="error">{{ error }}</section>

    <!-- QR login: prominent default flow -->
    <section class="qr-login-cta">
      <button class="btn-qr-login" @click="showQrLogin = true">
        扫码添加微信机器人
      </button>
      <p class="cta-hint">
        填写机器人名称并选择默认 Agent，然后使用微信扫描二维码。授权完成后，机器人会自动创建并启动。
      </p>
    </section>



    <section class="channel-list">
      <h3>微信机器人（{{ channels.length }}）</h3>
      <div v-if="loading">正在加载微信机器人…</div>
      <div v-else-if="channels.length === 0" class="empty">
        还没有微信机器人。点击上方“扫码添加微信机器人”开始配置。
      </div>
      <div v-else class="channel-cards">
        <div v-for="ch in channels" :key="ch.id" class="channel-card">
          <div class="card-header">
            <span class="status-dot" :class="getStatus(ch.id) === 'connected' ? 'status-connected' : 'status-stopped'" :title="getStatus(ch.id)"></span>
            <span class="card-name">{{ ch.displayName }}</span>
          </div>
          <div class="card-body">
            <div class="card-row">
              <span class="card-label">Agent</span>
              <button class="link" @click="openAgentEditor(ch)" :title="ch.defaultAgentId">
                {{ agentLabel(ch.defaultAgentId) }} <span class="edit-label">更改</span>
              </button>
            </div>
            <div class="card-row">
              <span class="card-label">当前会话</span>
              <button class="link" @click="openSessionEditor(ch)" :title="ch.currentSessionId">
                {{ sessionLabel(ch.currentSessionId) }} <span class="edit-label">更改</span>
              </button>
            </div>
            <div class="card-row">
              <span class="card-label">存储目录</span>
              <code class="card-value">{{ ch.storageDir ?? ch.extra?.storageDir ?? '—' }}</code>
            </div>
          </div>
          <div class="card-actions">
            <button v-if="getStatus(ch.id) !== 'connected'" @click="handleStart(ch.id)">启动</button>
            <button v-else @click="handleStop(ch.id)">停止</button>
            <button class="danger" @click="handleDelete(ch.id, ch.displayName)">删除</button>
          </div>
        </div>
      </div>
    </section>

    <!-- QR Login Dialog -->
    <QrLoginDialog
      v-if="showQrLogin"
      v-model:open="showQrLogin"
      channel-type="wechat"
      @connected="refresh"
    />

    <!-- Change Agent modal -->
    <div v-if="editingChannelId && !editingSessionId" class="modal-backdrop" @click.self="editingChannelId = null">
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

    <!-- Change Session modal -->
    <div v-if="editingChannelId && editingSessionId !== null" class="modal-backdrop" @click.self="editingChannelId = null; editingSessionId = null;">
      <div class="modal">
        <h3>更改当前会话</h3>
        <p class="hint">选择该 Agent 下的一个会话作为当前会话。</p>
        <label class="modal-field">
          <span>当前会话</span>
          <select v-model="editingSessionId">
            <option value="">无会话</option>
            <option v-for="s in sessions" :key="s.id" :value="s.id">
              {{ s.title ?? s.id.slice(0, 8) + '…' }}
            </option>
          </select>
        </label>
        <div class="modal-actions">
          <button @click="editingChannelId = null; editingSessionId = null;">取消</button>
          <button class="primary" @click="saveSessionEditor">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wechat-channels-page { padding: 16px; }
.page-header { margin-bottom: 16px; }
.page-header h2 { margin: 0; color: var(--text); }
.hint { color: var(--warning); font-size: 14px; margin: 4px 0 0; }
.error {
  background: var(--danger-soft);
  color: var(--danger);
  padding: 12px;
  border-radius: 6px;
  margin-bottom: 16px;
}

/* 扫码入口 —— 用主题强调色，亮/暗主题下都保持可读 */
.qr-login-cta {
  background: var(--accent-soft);
  border: 2px solid var(--accent);
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 16px;
  text-align: center;
}
.btn-qr-login {
  background: var(--accent);
  color: #fff;
  border: none;
  padding: 14px 28px;
  font-size: 16px;
  font-weight: 600;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.15s ease, transform 0.15s ease;
}
.btn-qr-login:hover { background: var(--accent-hover); transform: translateY(-1px); }
.cta-hint { color: var(--accent-ink); font-size: 13px; margin: 12px 0 0; }

.channel-list { padding: 0; }
.channel-list h3 { margin: 0 0 12px; color: var(--text); }

.channel-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
  gap: 16px;
}

.channel-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.card-header { display: flex; align-items: center; gap: 8px; }
.card-name { font-weight: 600; font-size: 1rem; color: var(--text); }
.card-body { display: flex; flex-direction: column; gap: 8px; }
.card-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.card-label { color: var(--text-secondary); font-size: 0.85rem; min-width: 70px; flex: none; }
.card-value { font-size: 0.85rem; color: var(--text); word-break: break-all; }
.card-actions {
  display: flex;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

button {
  padding: 6px 12px;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  border-radius: 4px;
  cursor: pointer;
  margin-right: 4px;
}
button:hover { background: var(--surface-hover); }
button.danger { color: var(--danger); border-color: var(--danger); }
button.link {
  background: transparent;
  border: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent);
  color: var(--accent-ink);
  padding: 4px 10px;
}
button.link:hover { background: var(--accent-soft); border-style: solid; }
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button.primary:hover { background: var(--accent-hover); }
.edit-label { font-size: 11px; margin-left: 4px; opacity: 0.7; }
.empty { color: var(--text-tertiary); padding: 24px; text-align: center; }

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, #0b1220 52%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 1000;
}
.modal {
  background: var(--surface-raised);
  color: var(--text);
  border-radius: 8px;
  padding: 24px;
  max-width: 480px;
  width: 100%;
  max-height: 88vh;
  overflow-y: auto;
}
.modal h3 { margin: 0 0 8px; color: var(--text); }
.modal .hint { color: var(--text-secondary); font-size: 13px; margin: 0 0 16px; }
.modal-field { display: grid; gap: 5px; color: var(--text-secondary); font-size: 13px; }
.modal select {
  width: 100%;
  padding: 8px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  font-size: 14px;
  background: var(--surface);
  color: var(--text);
}
.modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }

/* 状态语义色（spec 允许的例外）：仍用主题变量，保证暗色下可读 */
.status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.status-connected { background: var(--success); }
.status-stopped { background: var(--danger); }

/* 紧凑断点：卡片单列、操作按钮折行、长文本不撑破（spec channel-admin-theming） */
@media (max-width: 767px) {
  .wechat-channels-page { padding: 12px; }
  .qr-login-cta { padding: 16px; }
  .btn-qr-login { width: 100%; }
  .channel-cards { gap: 12px; }
  .card-row { align-items: flex-start; flex-direction: column; gap: 4px; }
  .card-label { min-width: 0; }
  .card-actions { flex-wrap: wrap; }
  .card-actions button { min-height: 44px; flex: 1; margin-right: 0; }
  button { min-height: 44px; }
  button.link { min-height: 40px; }
  .modal { padding: 18px; }
  .modal select { min-height: 44px; font-size: 16px; }
  .modal-actions button { flex: 1; }
}
</style>
