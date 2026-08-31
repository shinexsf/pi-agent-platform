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
 *   - SSE pushes: qr-url (we render URL → PNG via qrcode lib) → qr-scanned
 *     → connected (auto-close)
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

// Setup form fields (WeChat requires displayName; no SDK bot-name auto-fetch)
const form = ref({
  displayName: '',
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

async function loadAgents(): Promise<void> {
  agentsLoading.value = true;
  try {
    // /api/agents is top-level, so use raw fetch. Be permissive: any failure
    // (network, mock test setups without fetch, etc.) just leaves the list
    // empty so the user still sees the dropdown with the placeholder option.
    const res = await fetch('/api/agents').catch(() => null);
    if (res && typeof res.ok === 'boolean' && res.ok) {
      const list = (await res.json().catch(() => [])) as AgentRow[] | { agents?: AgentRow[] };
      if (Array.isArray(list)) agents.value = list;
      else if (list && Array.isArray((list as { agents?: AgentRow[] }).agents))
        agents.value = (list as { agents?: AgentRow[] }).agents ?? [];
    }
  } catch (err) {
    console.warn('[wechat-dialog] failed to load agents', err);
  } finally {
    agentsLoading.value = false;
  }
}

// Scan phase state
const channelId = ref<string | null>(null);
const qrUrl = ref<string | null>(null);
// Raw value emitted by SDK (often a URL string, sometimes data URL / base64).
const qrRaw = ref<string | null>(null);
const qrRawKind = ref<'url' | 'data' | 'base64' | 'unknown'>('unknown');
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
 * The SDK's `onQrUrl` callback receives `qrcode_img_content` from iLink. Empirically
 * this is the scan URL itself (e.g. "https://liteapp.weixin.qq.com/q/...") — NOT a
 * pre-rendered image. We must render the QR locally.
 *
 * - data URL (starts with "data:") → use as-is
 * - http(s) URL or relative path → treat as text payload, render with qrcode lib
 * - raw base64 → prefix with PNG data URL header
 */
async function toRenderableQr(content: string): Promise<{ dataUrl: string; kind: 'url' | 'data' | 'base64' }> {
  if (!content) return { dataUrl: '', kind: 'base64' };
  if (content.startsWith('data:')) return { dataUrl: content, kind: 'data' };
  // Heuristic: anything starting with http://, https://, or / is treated as a URL
  // string that we must render ourselves. Raw base64 is very long and contains no
  // colons or slashes near the start.
  const looksLikeUrl = /^(https?:\/\/|\/)/i.test(content) || content.includes('liteapp.weixin.qq.com');
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
}

async function handleSubmitSetup(): Promise<void> {
  if (!host()) return;
  if (!form.value.displayName || !form.value.defaultAgentId) {
    errorMsg.value = 'displayName 和 defaultAgentId 是必填的';
    return;
  }
  errorMsg.value = null;

  try {
    // Both WeChat and QQ use /qr-login now (with placeholder fields). The
    // actual credentials come from the SDK flow after scanning:
    //   - WeChat: iLink SDK after QR scan (no appId/appSecret needed in form)
    //   - QQ: connector's onSuccess returns appId/appSecret automatically
    const body = {
      displayName: form.value.displayName,
      defaultAgentId: form.value.defaultAgentId,
    };
    const res = (await host()!.apiFetch('POST', '/qr-login', body)) as { channelId: string };
    channelId.value = res.channelId;
    phase.value = 'scan';
    startSseThenStart();
  } catch (err) {
    errorMsg.value = String(err);
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
        const raw = (event.data as { qrRawPreview?: string } | undefined)?.qrRawPreview;
        if (url) {
          qrRaw.value = raw ?? url;
          // Render via qrcode lib (handles all 3 SDK formats)
          toRenderableQr(url).then((res) => {
            qrUrl.value = res.dataUrl;
            qrRawKind.value = res.kind;
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
        host()?.showToast({ message: '登录成功!', variant: 'success' });
        setTimeout(() => {
          emit('update:open', false);
          emit('connected');
        }, 1500);
      } else if (event.kind === 'error' || event.kind === 'start-failed') {
        state.value = 'error';
        errorMsg.value = event.message ?? '登录失败';
      }
    },
  });

  // 2. Trigger SDK login (small delay to ensure SSE handler is attached)
  setTimeout(() => {
    if (!channelId.value) return;
    const h = host();
    if (!h) return;
    h.apiFetch('POST', `/channels/${channelId.value}/start-qr`).catch((err: unknown) => {
      errorMsg.value = String(err);
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
    if (open) {
      reset();
      loadAgents();
    } else { stopStream?.(); stopStream = null; }
  },
  { immediate: true },
);

onBeforeUnmount(() => stopStream?.());
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="qr-overlay" @click.self="close">
      <div class="qr-dialog">
        <div class="dialog-header">
          <h3>
            <span v-if="channelType === 'wechat'">📱 扫码登录新微信机器人</span>
            <span v-else>🤖 创建 QQ 机器人</span>
          </h3>
          <button class="btn-close" @click="close">×</button>
        </div>

        <!-- Phase 1: Setup form -->
        <div v-if="phase === 'setup'" class="setup-form">
          <p v-if="channelType === 'wechat'" class="hint">
            填写机器人信息 → 点击 "开始扫码" → 用 iOS 微信扫码 → 完成
          </p>
          <p v-else class="hint">填写机器人信息(QQ 渠道不需要扫码,直接创建)</p>

          <label>
            <span>Display Name <em>*</em></span>
            <input v-model="form.displayName" placeholder="e.g. 客服小助手" />
          </label>
          <label>
            <span>Default Agent <em>*</em></span>
            <select v-model="form.defaultAgentId" :disabled="agentsLoading">
              <option value="" disabled>{{ agentsLoading ? '加载中…' : agents.length === 0 ? '暂无 Agent,请先创建' : '选择 Agent' }}</option>
              <option v-for="a in agents" :key="a.id" :value="a.id">
                {{ a.name }} — {{ a.model }}{{ a.description ? ` (${a.description})` : '' }}
              </option>
            </select>
          </label>

          <div v-if="errorMsg" class="error">{{ errorMsg }}</div>

          <div class="actions">
            <button @click="close">取消</button>
            <button class="primary" @click="handleSubmitSetup">
              {{ channelType === 'wechat' ? '开始扫码' : '创建并启动' }}
            </button>
          </div>
        </div>

        <!-- Phase 2: Scan panel -->
        <div v-else-if="phase === 'scan' || phase === 'connected'" class="scan-panel">
          <p v-if="channelType === 'wechat'" class="hint">
            ⚠️ 仅 iOS 微信支持扫码
          </p>

          <div class="scan-grid">
            <!-- QR + status -->
            <div class="qr-side">
              <div v-if="state === 'waiting'" class="state waiting">
                <div class="spinner" />
                <p>等待 SDK 生成 QR...</p>
              </div>

              <div v-else-if="state === 'qr-shown' || state === 'scanned'" class="state">
                <img v-if="qrUrl" :src="qrUrl" alt="QR code" class="qr-image" />
                <p v-if="state === 'scanned'" class="status scanned">已扫码,等待确认...</p>
                <small v-else-if="channelType === 'wechat'">用 iOS 微信扫描 ({{ qrRawKind }})</small>
                <small v-else>正在连接 QQ 服务器...</small>
              </div>

              <div v-else-if="state === 'expired'" class="state expired">
                <p>QR 码已过期</p>
              </div>

              <div v-else-if="state === 'connected'" class="state connected">
                <p>✅ 登录成功</p>
              </div>

              <div v-else-if="state === 'error'" class="state error">
                <p>❌ {{ errorMsg ?? '登录失败' }}</p>
              </div>
            </div>

            <!-- Live event log -->
            <div class="log-side">
              <h5>实时事件 ({{ events.length }})</h5>
              <div v-if="events.length === 0" class="log-empty">暂无事件 (SDK 正在初始化...)</div>
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
          <p>❌ {{ errorMsg }}</p>
          <button @click="reset">重试</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.qr-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 9000;
}
.qr-dialog {
  background: white;
  border-radius: 8px;
  width: 720px; max-width: 92vw; max-height: 90vh;
  display: flex; flex-direction: column;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25);
  overflow: hidden;
}
.dialog-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 24px; border-bottom: 1px solid #e5e7eb;
}
.dialog-header h3 { margin: 0; font-size: 16px; }
.btn-close { background: none; border: none; cursor: pointer; font-size: 24px; color: #6b7280; line-height: 1; }

.setup-form { padding: 24px; display: flex; flex-direction: column; gap: 12px; }
.setup-form label { display: flex; flex-direction: column; gap: 4px; }
.setup-form label span { font-size: 13px; color: #4b5563; font-weight: 500; }
.setup-form label em { color: #ef4444; font-style: normal; }
.setup-form input {
  padding: 8px 12px; border: 1px solid #d1d5db; border-radius: 4px;
  font-size: 14px;
}
.setup-form input:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
.setup-form .hint { color: #6b7280; font-size: 13px; margin: 0 0 8px; }
.setup-form .error { background: #fee; color: #c00; padding: 8px 12px; border-radius: 4px; font-size: 13px; }

.scan-panel { padding: 16px 24px 24px; }
.scan-panel .hint { color: #f59e0b; font-size: 13px; margin: 0 0 12px; }

.scan-grid {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 16px;
  min-height: 280px;
}
.qr-side, .log-side {
  background: #f9fafb;
  border: 1px solid #e5e7eb;
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
  border: 1px solid #e5e7eb; border-radius: 4px;
  background: white;
}
.state.connected { color: #10b981; font-weight: 600; }
.state.error { color: #ef4444; }
.state.expired { color: #f59e0b; }
.spinner {
  width: 32px; height: 32px;
  border: 3px solid #e5e7eb; border-top-color: #3b82f6;
  border-radius: 50%; animation: spin 1s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.log-side h5 { margin: 0 0 8px; font-size: 13px; color: #6b7280; font-weight: 500; }
.log-empty { color: #9ca3af; font-size: 13px; padding: 24px; text-align: center; }
.log-list {
  list-style: none; padding: 0; margin: 0;
  max-height: 240px; overflow-y: auto;
  font-family: ui-monospace, monospace; font-size: 12px;
}
.log-list li {
  padding: 4px 8px; border-bottom: 1px solid #f3f4f6;
  display: flex; gap: 8px; align-items: baseline;
}
.log-list li:last-child { border-bottom: none; }
.time { color: #9ca3af; flex-shrink: 0; }
.kind { font-weight: 600; flex-shrink: 0; min-width: 100px; }
.msg { color: #4b5563; flex: 1; word-break: break-word; }
.kind-qr-url { color: #3b82f6; }
.kind-qr-scanned { color: #8b5cf6; }
.kind-connected { color: #10b981; }
.kind-error, .kind-start-failed { color: #ef4444; }
.kind-token-refreshed { color: #6366f1; }

.actions {
  display: flex; gap: 8px; justify-content: flex-end;
  margin-top: 16px; padding-top: 16px; border-top: 1px solid #f3f4f6;
}
.actions button {
  padding: 8px 16px; border: 1px solid #d1d5db;
  background: white; border-radius: 4px; cursor: pointer;
}
.actions button:hover { background: #f9fafb; }
.actions button.primary {
  background: #3b82f6; color: white; border-color: #3b82f6;
}
.actions button.primary:hover { background: #2563eb; }

.error-panel { padding: 24px; text-align: center; }
.error-panel p { color: #ef4444; }
</style>