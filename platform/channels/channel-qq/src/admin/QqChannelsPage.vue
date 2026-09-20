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
import AppIcon from '../../../../apps/pi-agent-web/src/components/ui/AppIcon.vue';
import DropdownMenu from '../../../../apps/pi-agent-web/src/components/ui/DropdownMenu.vue';

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

const channels = ref<QqChannel[]>([]);
const channelStatus = ref<Record<string, string>>({});
const agents = ref<AgentRow[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const showCreate = ref(false);
const editingChannelId = ref<string | null>(null);
const editingAgentId = ref<string>('');
const editingSessionId = ref<string | null>(null);
const sessions = ref<SessionRow[]>([]);
/** 缓存 session title（按 ID 直接查，避免分页列表里找不到） */

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

async function loadSessions(agentId?: string): Promise<void> {
  try {
    const url = agentId ? `/api/sessions?agent_id=${agentId}` : '/api/sessions';
    const res = await fetch(url).catch(() => null);
    if (res && typeof res.ok === 'boolean' && res.ok) {
      const data = await res.json().catch(() => ({ sessions: [] }));
      sessions.value = data.sessions ?? [];
    }
  } catch (err) {
    console.warn('[qq-page] failed to load sessions', err);
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
  await Promise.all([refresh(), loadAgents(), loadSessions()]);
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

function openSessionEditor(ch: QqChannel): void {
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

function sessionLabel(ch: QqChannel): string {
  if (!ch.currentSessionId) return '—';
  return ch.currentSessionTitle ?? ch.currentSessionId;
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
      <div v-else class="channel-cards">
        <div v-for="ch in channels" :key="ch.id" class="channel-card">
          <div class="card-header">
            <span class="status-dot" :class="getStatus(ch.id) === 'connected' ? 'status-connected' : 'status-stopped'" :title="getStatus(ch.id)"></span>
            <span class="card-name">{{ ch.displayName }}</span>
            <div class="card-header-actions">
              <button
                class="btn-icon-sm"
                :class="getStatus(ch.id) === 'connected' ? 'is-danger' : 'is-live'"
                :title="getStatus(ch.id) === 'connected' ? '停止' : '启动'"
                @click="getStatus(ch.id) === 'connected' ? handleStop(ch.id) : handleStart(ch.id)"
              >
                <AppIcon :name="getStatus(ch.id) === 'connected' ? 'stop' : 'play'" :size="14" />
              </button>
              <DropdownMenu>
                <button class="dropdown-item" @click.stop="openAgentEditor(ch)">
                  <AppIcon name="edit" :size="14" />
                  <span>更改 Agent</span>
                </button>
                <button class="dropdown-item" @click.stop="openSessionEditor(ch)">
                  <AppIcon name="sessions" :size="14" />
                  <span>更改会话</span>
                </button>
                <button class="dropdown-item is-danger" @click.stop="handleDelete(ch.id, ch.displayName)">
                  <AppIcon name="trash" :size="14" />
                  <span>删除</span>
                </button>
              </DropdownMenu>
            </div>
          </div>
          <div class="card-body">
            <div class="card-row">
              <span class="card-label">Agent</span>
              <span class="card-value truncate" :title="ch.defaultAgentId">{{ agentLabel(ch.defaultAgentId) }}</span>
            </div>
            <div class="card-row">
              <span class="card-label">当前会话</span>
              <span class="card-value truncate" :title="ch.currentSessionId ?? ''">{{ sessionLabel(ch) }}</span>
            </div>
            <div class="card-row">
              <span class="card-label">App ID</span>
              <span class="card-value truncate" :title="ch.appId ?? ch.extra?.appId ?? ''">{{ ch.appId ?? ch.extra?.appId ?? '—' }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>

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

    <QrLoginDialog
      v-if="showCreate"
      v-model:open="showCreate"
      channel-type="qq"
      @connected="refresh"
    />
  </div>
</template>

<style scoped>
.qq-channels-page {
  width: 100%;
  padding: 16px; }
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
  padding: 10px;
  margin-bottom: 16px;
  text-align: center;
}
.btn-qr-login {
  background: var(--accent);
  color: #fff;
  border: none;
  padding: 8px 16px;
  font-size: 14px;
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
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.card-header { display: flex; align-items: center; gap: 6px; }
.card-name { font-weight: 600; font-size: 0.85rem; color: var(--text); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-header-actions { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.btn-icon-sm { display: inline-flex; width: 26px; height: 26px; align-items: center; justify-content: center; border: 0 !important; border-radius: 6px; background: transparent; color: var(--text-secondary); cursor: pointer; padding: 0; }
.btn-icon-sm:hover { background: var(--surface-hover); color: var(--text); }
.btn-icon-sm.is-live { color: var(--success); }
.btn-icon-sm.is-live:hover { background: var(--success-soft); }
.btn-icon-sm.is-danger { color: var(--danger); }
.btn-icon-sm.is-danger:hover { background: var(--danger-soft); }
.card-body { display: flex; flex-direction: column; gap: 4px; }
.card-row { display: flex; align-items: center; gap: 4px; min-width: 0; }
.card-label { color: var(--text-secondary); font-size: 0.7rem; min-width: 46px; flex: none; }
.card-value { font-size: 0.7rem; color: var(--text); flex: 1; min-width: 0; }
.card-value.truncate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dropdown-item:hover { background: var(--surface-hover); }
.dropdown-item.is-danger { color: var(--danger); }
.dropdown-item.is-danger:hover { background: var(--danger-soft); }

@media (max-width: 767px) {
  .card-row { gap: 4px; }
  .card-label { min-width: auto; }
  .card-value { min-width: 0; }
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
button.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
button.primary:hover { background: var(--accent-hover); }
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
  padding: 18px;
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
  .qq-channels-page {
  padding: 12px; }
  .qr-login-cta { padding: 10px; }
  .btn-qr-login { width: 100%; }
  .channel-cards { gap: 12px; }
  .card-row { gap: 4px; }
  .card-label { min-width: 0; }
  .card-actions { flex-wrap: wrap; }
  .card-actions button { min-height: 28px; flex: 1; margin-right: 0; font-size: 12px; padding: 4px 8px; }
  button { min-height: 28px; padding: 4px 8px; font-size: 12px; }
  .modal { padding: 18px; }
  .modal select { min-height: 34px; font-size: 16px; }
  .modal-actions button { flex: 1; }
}
</style>
