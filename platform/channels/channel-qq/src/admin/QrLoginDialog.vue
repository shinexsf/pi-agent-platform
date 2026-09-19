<script setup lang="ts">
/**
 * QrLoginDialog — full WeChat / QQ login flow inside the admin page.
 *
 * Two phases:
 *   Phase 1 (Setup): inline form with displayName + defaultAgentId
 *                    (QQ also needs appId + appSecret)
 *   Phase 2 (Scan): SSE-subscribed QR panel showing live SDK events
 *
 * Flow:
 *   - Phase 1 submits to POST /api/im/<type>/qr-login → server creates row +
 *     auto-assigns storageDir → returns { channelId }
 *   - We subscribe to /api/im/events?channelId=<id> BEFORE calling
 *     /start-qr, so no QR event is missed.
 *   - POST /api/im/<type>/channels/:id/start-qr → server triggers SDK login
 *   - SSE pushes: qr-url (image renders) → qr-scanned → connected (auto-close)
 */
import { ref, watch, onBeforeUnmount } from 'vue';
import QRCode from 'qrcode';
import { startChannelLogStream } from './composables/useChannelLogStream';

const props = defineProps<{
  open: boolean;
  channelType: 'wechat' | 'qq';
  /** For QQ, appId/appSecret inputs are required. */
}>();

const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'connected'): void;
}>();

const phase = ref<'setup' | 'scan' | 'connected' | 'error'>('setup');

// Setup form fields (QQ auto-fetches displayName via /users/@me after QR scan)
const form = ref({
  defaultAgentId: '',
});

// Agent list fetched from /api/agents
interface AgentRow {
  id: string;
  name: string;
  description?: string;
  model: string;
}
const agents = ref<AgentRow[]>([]);
const agentsLoading = ref(false);
const agentsError = ref<string | null>(null);

async function loadAgents(): Promise<void> {
  agentsLoading.value = true;
  agentsError.value = null;
  try {
    // /api/agents is top-level (not under /api/im/<type>/), so we must use raw fetch
    // instead of host.apiFetch (which prefixes with /api/im/<type>).
    const res = await fetch('/api/agents');
    if (!res.ok) throw new Error(`/api/agents returned ${res.status}`);
    const list = (await res.json()) as AgentRow[] | { agents?: AgentRow[] };
    if (Array.isArray(list)) {
      agents.value = list;
    } else if (list && Array.isArray((list as { agents?: AgentRow[] }).agents)) {
      agents.value = (list as { agents?: AgentRow[] }).agents ?? [];
    }
  } catch {
    agents.value = [];
    agentsError.value = '无法加载 Agent 列表。请关闭窗口后重新打开。';
  } finally {
    agentsLoading.value = false;
  }
}

// Scan phase state
const channelId = ref<string | null>(null);
const qrUrl = ref<string | null>(null);
const state = ref<'waiting' | 'qr-shown' | 'scanned' | 'expired' | 'connected' | 'error'>('waiting');
const errorMsg = ref<string | null>(null);
const events = ref<Array<{ kind: string; message?: string; timestamp: string; data?: unknown }>>([]);

let stopStream: (() => void) | null = null;

declare global {
  interface Window {
    __channelAdminHost?: {
      apiFetch: (method: string, path: string, body?: unknown) => Promise<unknown>;
      showToast: (opts: { message: string; variant?: string }) => void;
      showConfirmDialog: (opts: { title: string; message: string }) => Promise<boolean>;
      useI18n: () => { t: (k: string) => string };
    };
  }
}

function host(): Window['__channelAdminHost'] {
  return window.__channelAdminHost;
}

/**
 * Convert whatever the SDK returned into a PNG data URL the browser can render.
 *
 * Both WeChat (iLink) and QQ (q.qq.com) connectors return the *scan URL* as
 * `qrcode_img_content` / `qrUrl` — NOT a pre-rendered image. We must render
 * the QR ourselves using the `qrcode` library.
 */
async function toRenderableQr(content: string): Promise<{ dataUrl: string; kind: 'url' | 'data' | 'base64' }> {
  if (!content) return { dataUrl: '', kind: 'base64' };
  if (content.startsWith('data:')) return { dataUrl: content, kind: 'data' };
  // Heuristic: anything starting with http(s):// or / is treated as a URL
  // string that we must render ourselves.
  const looksLikeUrl = /^(https?:\/\/|\/)/i.test(content) || content.includes('q.qq.com') || content.includes('weixin.qq.com');
  if (looksLikeUrl) {
    try {
      const dataUrl = await QRCode.toDataURL(content, { width: 280, margin: 1, errorCorrectionLevel: 'M' });
      return { dataUrl, kind: 'url' };
    } catch (err) {
      console.warn('[qr] failed to render URL as QR', err);
      return { dataUrl: content, kind: 'url' };
    }
  }
  // Treat as raw base64 PNG
  return { dataUrl: `data:image/png;base64,${content.replace(/\s+/g, '')}`, kind: 'base64' };
}

function reset(): void {
  phase.value = 'setup';
  channelId.value = null;
  qrUrl.value = null;
  state.value = 'waiting';
  errorMsg.value = null;
  events.value = [];
  stopStream?.();
  stopStream = null;
  // Refresh agents each time dialog opens (so newly-created agents show up).
  if (props.open) loadAgents();
}

// Watch open prop to refresh agents when dialog opens.
watch(() => props.open, (open) => {
  if (open) loadAgents();
}, { immediate: true });

async function handleSubmitSetup(): Promise<void> {
  if (!host()) return;
  if (!form.value.defaultAgentId) {
    errorMsg.value = '请选择一个 Agent';
    return;
  }
  errorMsg.value = null;

  try {
    // For both WeChat and QQ, the QR flow now provides credentials:
    //   - WeChat: SDK returns token (stored in storageDir)
    //   - QQ: connector returns {appId, appSecret} via onSuccess
    // No user-typed appId/appSecret required. displayName is auto-fetched
    // from /users/@me by the connector on success.
    const body = {
      defaultAgentId: form.value.defaultAgentId,
    };
    const res = (await host()!.apiFetch('POST', '/qr-login', body)) as { channelId: string };
    channelId.value = res.channelId;
    phase.value = 'scan';
    startSseThenStart();
  } catch {
    errorMsg.value = '无法创建 QQ 机器人。请检查服务连接后重试。';
  }
}

function startSseThenStart(): void {
  if (!channelId.value) return;
  // 1. Subscribe to SSE FIRST (before SDK emits QR)
  stopStream = startChannelLogStream({
    channelId: channelId.value,
    onEvent: (event) => {
      events.value.unshift({
        kind: event.kind,
        message: event.message,
        timestamp: event.timestamp,
        data: event.data,
      });
      if (events.value.length > 50) events.value.length = 50;

      if (event.kind === 'qr-url') {
        const url = (event.data as { qrUrl?: string } | undefined)?.qrUrl;
        if (url) {
          // Render via qrcode lib (handles all 3 SDK formats)
          toRenderableQr(url).then((res) => {
            qrUrl.value = res.dataUrl;
          });
          state.value = 'qr-shown';
        }
      } else if (event.kind === 'qr-scanned') {
        state.value = 'scanned';
      } else if (event.kind === 'qr-expired') {
        state.value = 'expired';
      } else if (event.kind === 'connected') {
        state.value = 'connected';
        phase.value = 'connected';
        host()?.showToast({ message: 'QQ 机器人已连接。', variant: 'success' });
        setTimeout(() => {
          emit('update:open', false);
          emit('connected');
        }, 1500);
      } else if (event.kind === 'error' || event.kind === 'start-failed') {
        state.value = 'error';
        errorMsg.value = 'QQ 登录失败。请查看事件记录后重试。';
      }
    },
  });

  // 2. Trigger SDK login (small delay to ensure SSE handler is attached)
  setTimeout(() => {
    if (!channelId.value) return;
    host()?.apiFetch('POST', `/channels/${channelId.value}/start-qr`).catch(() => {
      errorMsg.value = '无法启动 QQ 扫码授权。请关闭窗口后重试。';
      state.value = 'error';
    });
  }, 100);
}

function close(): void {
  emit('update:open', false);
}

function fmtTime(ts: string): string {
  try { return new Date(ts).toLocaleTimeString(); } catch { return ts; }
}

watch(
  () => props.open,
  (open) => {
    if (open) reset();
    else { stopStream?.(); stopStream = null; }
  },
  { immediate: true },
);

onBeforeUnmount(() => stopStream?.());
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="qr-overlay" @click.self="close">
      <div class="qr-dialog" role="dialog" aria-modal="true" aria-labelledby="qq-qr-title">
        <div class="dialog-header">
          <h3 id="qq-qr-title">
            <span v-if="channelType === 'wechat'">扫码添加微信机器人</span>
            <span v-else>扫码添加 QQ 机器人</span>
          </h3>
          <button class="btn-close" type="button" aria-label="关闭" @click="close">×</button>
        </div>

        <!-- Phase 1: Setup form -->
        <div v-if="phase === 'setup'" class="setup-form">
          <p v-if="channelType === 'wechat'" class="hint">
            填写机器人信息，然后使用 iOS 微信扫描二维码。
          </p>
          <p v-else class="hint">
            选择默认 Agent，然后使用手机 QQ 扫描二维码并完成授权。机器人名称会从 QQ 自动获取。
          </p>

          <label>
            <span>默认 Agent <em>*</em></span>
            <select v-model="form.defaultAgentId" :disabled="agentsLoading">
              <option value="" disabled>{{ agentsLoading ? '正在加载 Agent…' : agentsError ? '无法加载 Agent 列表' : agents.length === 0 ? '暂无 Agent，请先创建' : '选择 Agent' }}</option>
              <option v-for="a in agents" :key="a.id" :value="a.id">
                {{ a.name }} — {{ a.model }}{{ a.description ? ` (${a.description})` : '' }}
              </option>
            </select>
          </label>

          <div v-if="agentsError" class="error">{{ agentsError }}</div>
          <div v-if="errorMsg" class="error">{{ errorMsg }}</div>

          <div class="actions">
            <button @click="close">取消</button>
            <button class="primary" @click="handleSubmitSetup">
              {{ channelType === 'wechat' ? '开始扫码' : '扫码添加机器人' }}
            </button>
          </div>
        </div>

        <!-- Phase 2: Scan panel -->
        <div v-else-if="phase === 'scan' || phase === 'connected'" class="scan-panel">
          <p v-if="channelType === 'wechat'" class="hint">
            目前仅支持使用 iOS 微信扫码登录。
          </p>

          <div class="scan-grid">
            <!-- QR + status -->
            <div class="qr-side">
              <div v-if="state === 'waiting'" class="state waiting">
                <div class="spinner" />
                <p>正在生成二维码…</p>
              </div>

              <div v-else-if="state === 'qr-shown' || state === 'scanned'" class="state">
                <img v-if="qrUrl" :src="qrUrl" alt="QQ 授权二维码" class="qr-image" />
                <p v-if="state === 'scanned'" class="status scanned">已扫码，请在手机上确认授权。</p>
                <small v-else-if="channelType === 'wechat'">请使用手机微信扫描二维码。</small>
                <small v-else>请使用手机 QQ 扫描二维码并授权。</small>
              </div>

              <div v-else-if="state === 'expired'" class="state expired">
                <p>二维码已过期，请关闭窗口后重新开始。</p>
              </div>

              <div v-else-if="state === 'connected'" class="state connected">
                <p>授权成功，正在完成配置…</p>
              </div>

              <div v-else-if="state === 'error'" class="state error">
                <p>{{ errorMsg ?? '授权失败。请查看事件记录后重试。' }}</p>
              </div>
            </div>

            <!-- Live event log -->
            <div class="log-side">
              <h5>事件记录（{{ events.length }}）</h5>
              <div v-if="events.length === 0" class="log-empty">暂时没有事件，正在初始化授权服务…</div>
              <ul v-else class="log-list">
                <li v-for="(ev, i) in events" :key="i" :class="`kind-${ev.kind}`">
                  <span class="time">{{ fmtTime(ev.timestamp) }}</span>
                  <span class="kind">{{ ev.kind }}</span>
                  <span v-if="ev.message" class="msg">{{ ev.message }}</span>
                </li>
              </ul>
            </div>
          </div>

          <div class="actions">
            <button @click="close">关闭</button>
          </div>
        </div>

        <!-- Error fallback -->
        <div v-else-if="phase === 'error'" class="error-panel">
          <p>{{ errorMsg }}</p>
          <button @click="reset">重试</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.qr-overlay {
  position: fixed; inset: 0;
  background: color-mix(in srgb, #0b1220 52%, transparent);
  display: flex; align-items: center; justify-content: center;
  z-index: 9000;
}
.qr-dialog {
  background: var(--surface);
  border-radius: 8px;
  width: 720px; max-width: 92vw; max-height: 90vh;
  display: flex; flex-direction: column;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
.dialog-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 24px; border-bottom: 1px solid var(--border);
}
.dialog-header h3 { margin: 0; font-size: 16px; }
.btn-close { background: none; border: none; cursor: pointer; font-size: 24px; color: var(--text-secondary); line-height: 1; }

.setup-form { padding: 24px; display: flex; flex-direction: column; gap: 12px; }
.setup-form label { display: flex; flex-direction: column; gap: 4px; }
.setup-form label span { font-size: 13px; color: var(--text-secondary); font-weight: 500; }
.setup-form label em { color: var(--danger); font-style: normal; }
.setup-form input {
  padding: 8px 12px; border: 1px solid var(--border-strong); border-radius: 4px;
  font-size: 14px;
}
.setup-form input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 24%, transparent); }
.setup-form .hint { color: var(--text-secondary); font-size: 13px; margin: 0 0 8px; }
.setup-form .error { background: var(--danger-soft); color: var(--danger); padding: 8px 12px; border-radius: 4px; font-size: 13px; }

.scan-panel { padding: 16px 24px 24px; }
.scan-panel .hint { color: var(--warning); font-size: 13px; margin: 0 0 12px; }

.scan-grid {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 16px;
  min-height: 280px;
}
.qr-side, .log-side {
  background: var(--surface-hover);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
}
.state {
  text-align: center;
  padding: 16px;
  min-height: 240px;
  display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 8px;
}
.qr-image {
  max-width: 200px; width: 100%; height: auto;
  border: 1px solid var(--border); border-radius: 4px;
  background: var(--surface);
}
.state.connected { color: var(--success); font-weight: 600; }
.state.error { color: var(--danger); }
.state.expired { color: var(--warning); }
.spinner {
  width: 32px; height: 32px;
  border: 3px solid var(--border); border-top-color: var(--accent);
  border-radius: 50%; animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.log-side h5 { margin: 0 0 8px; font-size: 13px; color: var(--text-secondary); font-weight: 500; }
.log-empty { color: var(--text-tertiary); font-size: 13px; padding: 24px; text-align: center; }
.log-list {
  list-style: none; padding: 0; margin: 0;
  max-height: 240px; overflow-y: auto;
  font-family: ui-monospace, monospace; font-size: 12px;
}
.log-list li {
  padding: 4px 8px; border-bottom: 1px solid var(--surface-subtle);
  display: flex; gap: 8px; align-items: baseline;
}
.log-list li:last-child { border-bottom: none; }
.time { color: var(--text-tertiary); flex-shrink: 0; }
.kind { font-weight: 600; flex-shrink: 0; min-width: 100px; }
.msg { color: var(--text-secondary); flex: 1; word-break: break-word; }
.kind-qr-url { color: var(--accent); }
.kind-qr-scanned { color: var(--accent); }
.kind-connected { color: var(--success); }
.kind-error, .kind-start-failed { color: var(--danger); }
.kind-token-refreshed { color: var(--accent); }

.actions {
  display: flex; gap: 8px; justify-content: flex-end;
  margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--surface-subtle);
}
.actions button {
  padding: 8px 16px; border: 1px solid var(--border-strong);
  background: var(--surface); border-radius: 4px; cursor: pointer;
}
.actions button:hover { background: var(--surface-hover); }
.actions button.primary {
  background: var(--accent); color: #fff; border-color: var(--accent);
}
.actions button.primary:hover { background: var(--accent-hover); }

.error-panel { padding: 24px; text-align: center; }
.error-panel p { color: var(--danger); }

/* 紧凑断点：全屏展示（spec app-layout「渠道扫码移动端增强」）
   二维码是手机上唯一比桌面更顺的场景，因此不给它留弹框边框。 */
@media (max-width: 767px) {
  .qr-overlay { align-items: stretch; justify-content: stretch; }
  .qr-dialog {
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    border-radius: 0;
  }
  .dialog-header { padding: 12px 16px; }
  .btn-close { min-width: 44px; min-height: 44px; }
  .setup-form { padding: 16px; }
  .setup-form input { min-height: 44px; font-size: 16px; }
  .setup-form select { min-height: 44px; font-size: 16px; }
  .scan-panel { padding: 14px 16px calc(20px + env(safe-area-inset-bottom)); }
  .scan-grid { grid-template-columns: 1fr; min-height: 0; }
  .qr-side { display: flex; flex-direction: column; align-items: center; }
  .qr-image { max-width: min(76vw, 320px); }
  .state { min-height: 180px; }
}
</style>
