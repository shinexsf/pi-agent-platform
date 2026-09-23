<script setup lang="ts">
/**
 * SystemLogs — 系统日志查看（配置 → 二级菜单最后一位）
 *
 * 只读活跃日志文件（GET /api/server-logs，路径由 server 端 logger.ts 决定，
 * dev = dev-server.log / prod = server.log，前端不关心）。
 *
 * - level 过滤：最低级别语义（error → 只看 error+fatal）
 * - q 关键字：服务端对整行做子串匹配
 * - 实时：2s 轮询（日志速率低，轮询足够；且每次重读文件，滚动/重建自动兼容）
 * - 滚动钉底：用户在底部时新日志自动跟随，上翻查看时不动
 */
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue';

interface ServerLogLine {
  raw: string;
  time?: number;
  level?: number;
  name?: string;
  msg?: string;
}

interface ServerLogsResponse {
  file: string;
  exists: boolean;
  sizeBytes: number;
  mtimeMs: number;
  totalLines: number;
  matchedLines: number;
  lines: ServerLogLine[];
}

const TAIL_OPTIONS = [200, 500, 1000, 5000];
const LIVE_INTERVAL_MS = 2000;

const lines = ref<ServerLogLine[]>([]);
const file = ref('');
const exists = ref(true);
const sizeBytes = ref(0);
const mtimeMs = ref(0);
const totalLines = ref(0);
const matchedLines = ref(0);

const level = ref('');
const tail = ref(500);
const query = ref('');
const loading = ref(false);
const live = ref(true);
const error = ref('');

const listEl = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setInterval> | null = null;
let queryDebounce: ReturnType<typeof setTimeout> | null = null;
/** 用户是否停在底部（决定新日志是否自动跟随滚动） */
let pinnedToBottom = true;

onMounted(async () => {
  await load();
  scrollToBottom();
  applyLive();
});

onUnmounted(() => {
  stopTimer();
  if (queryDebounce) clearTimeout(queryDebounce);
});

// 关键字防抖 300ms（每次输入都打到 10MB 文件扫描不划算）
watch([level, tail], () => {
  void load();
});
watch(query, () => {
  if (queryDebounce) clearTimeout(queryDebounce);
  queryDebounce = setTimeout(() => void load(), 300);
});
watch(live, () => {
  applyLive();
});

function applyLive(): void {
  if (live.value) startTimer();
  else stopTimer();
}

function startTimer(): void {
  if (timer) return;
  timer = setInterval(() => void load(true), LIVE_INTERVAL_MS);
}

function stopTimer(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

async function load(isPoll = false): Promise<void> {
  if (loading.value) return; // 上一轮还没回来，跳过本轮（轮询防重入）
  loading.value = true;
  try {
    const params = new URLSearchParams({
      tail: String(tail.value),
      level: level.value,
      q: query.value.trim(),
    });
    const res = await fetch(`/api/server-logs?${params.toString()}`);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const data = (await res.json()) as ServerLogsResponse;
    lines.value = data.lines;
    file.value = data.file;
    exists.value = data.exists;
    sizeBytes.value = data.sizeBytes;
    mtimeMs.value = data.mtimeMs;
    totalLines.value = data.totalLines;
    matchedLines.value = data.matchedLines;
    error.value = '';
    if (pinnedToBottom) {
      await nextTick();
      scrollToBottom();
    }
  } catch (err) {
    // 轮询失败只记 inline（避免每 2s 一次 toast 刷屏）；手动刷新会触发同样路径
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

function onScroll(): void {
  const el = listEl.value;
  if (!el) return;
  pinnedToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function scrollToBottom(): void {
  const el = listEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

async function refresh(): Promise<void> {
  pinnedToBottom = true;
  await load();
  scrollToBottom();
}

// ── 展示辅助 ──────────────────────────────────────────────────────────────

function levelOf(line: ServerLogLine): { label: string; cls: string } {
  const lv = line.level ?? 30;
  if (lv >= 60) return { label: 'FATAL', cls: 'lv-error' };
  if (lv >= 50) return { label: 'ERROR', cls: 'lv-error' };
  if (lv >= 40) return { label: 'WARN', cls: 'lv-warn' };
  if (lv >= 30) return { label: 'INFO', cls: 'lv-info' };
  return { label: 'DEBUG', cls: 'lv-debug' };
}

function formatTime(time?: number, raw?: string): string {
  if (!time) return raw ? '' : '--:--:--';
  const d = new Date(time);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <div class="system-logs">
    <div class="logs-header">
      <div class="header-top">
        <h2 class="page-title">系统日志</h2>
        <div class="header-actions">
          <label class="live-toggle">
            <input v-model="live" type="checkbox" />
            <span>实时（2s）</span>
          </label>
          <button class="btn btn-secondary btn-sm" :disabled="loading" @click="refresh">
            {{ loading ? '加载中…' : '刷新' }}
          </button>
        </div>
      </div>

      <div class="file-meta" :title="file">
        <span class="file-path">{{ file || '…' }}</span>
        <span v-if="file">{{ formatSize(sizeBytes) }}</span>
        <span v-if="file && mtimeMs">更新于 {{ formatTime(mtimeMs) }}</span>
        <span>{{ matchedLines }} / {{ totalLines }} 行</span>
      </div>

      <div class="filters">
        <select v-model="level" class="form-select">
          <option value="">全部级别</option>
          <option value="debug">debug 及以上</option>
          <option value="info">info 及以上</option>
          <option value="warn">warn 及以上</option>
          <option value="error">仅 error</option>
        </select>
        <select v-model.number="tail" class="form-select tail-select">
          <option v-for="n in TAIL_OPTIONS" :key="n" :value="n">尾部 {{ n }} 行</option>
        </select>
        <input
          v-model="query"
          type="search"
          class="form-input"
          placeholder="过滤关键字（msg / 模块名 / 原始行）"
        />
      </div>

      <div v-if="error" class="logs-error">{{ error }}</div>
    </div>

    <div v-if="!exists" class="logs-empty">日志文件尚未生成</div>
    <div v-else-if="lines.length === 0 && !loading" class="logs-empty">暂无匹配日志</div>
    <div v-else ref="listEl" class="logs-list" @scroll="onScroll">
      <div v-for="(line, i) in lines" :key="i" class="log-row" :class="levelOf(line).cls">
        <span class="log-time">{{ formatTime(line.time, line.raw) }}</span>
        <span class="log-level">{{ levelOf(line).label }}</span>
        <span v-if="line.name" class="log-name">{{ line.name }}</span>
        <span class="log-msg">{{ line.msg ?? line.raw }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.system-logs {
  max-width: 1240px;
  margin: 0 auto;
  width: 100%;
  display: flex;
  flex-direction: column;
  /* 撑满壳高度：header 固定，日志列表内部滚动 */
  min-height: 0;
  height: calc(100vh - var(--app-header-h) - 96px);
}

.logs-header {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 12px;
}

.header-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.page-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 14px;
}

.live-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.85rem;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}

.live-toggle input {
  width: 15px;
  height: 15px;
  cursor: pointer;
}

.file-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 0.78rem;
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}

.file-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: min(560px, 70vw);
}

.filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.form-select,
.form-input {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 0.85rem;
  background: var(--bg);
  color: var(--text);
}

.form-select:focus,
.form-input:focus {
  outline: none;
  border-color: var(--accent);
}

.tail-select {
  flex-shrink: 0;
}

.form-input {
  flex: 1;
  min-width: 200px;
}

.logs-error {
  font-size: 0.8rem;
  color: var(--danger);
  background: var(--danger-soft);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
}

.logs-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 8px 0;
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.55;
}

.log-row {
  display: flex;
  gap: 10px;
  padding: 1px 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-row:hover {
  background: var(--surface-hover);
}

.log-time {
  flex-shrink: 0;
  color: var(--text-tertiary);
}

.log-level {
  flex-shrink: 0;
  width: 44px;
  font-weight: 600;
  text-align: right;
}

.log-name {
  flex-shrink: 0;
  color: var(--accent-ink);
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-msg {
  flex: 1;
  min-width: 0;
}

.lv-error .log-level { color: var(--danger); }
.lv-error .log-msg { color: var(--danger); }
.lv-warn .log-level { color: var(--warning); }
.lv-info .log-level { color: var(--text-secondary); }
.lv-debug .log-level { color: var(--text-tertiary); }
.lv-debug .log-msg { color: var(--text-secondary); }

.logs-empty {
  color: var(--text-secondary);
  text-align: center;
  padding: 40px 20px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-md);
}

.btn {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 150ms ease;
}

.btn-sm {
  padding: 6px 12px;
  font-size: 0.8rem;
}

.btn-secondary {
  background: var(--surface-hover);
  color: var(--text);
  border: 1px solid var(--border);
}

.btn-secondary:hover {
  background: var(--border);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 紧凑断点：列表高度改为视口自适应，过滤器换行，触摸目标 ≥44px */
@media (max-width: 767px) {
  .system-logs {
    height: calc(100vh - var(--app-header-h) - 150px);
  }

  .filters {
    flex-direction: column;
  }

  .form-select,
  .form-input {
    min-height: 44px;
    font-size: 16px; /* iOS 防缩放 */
  }

  .logs-list {
    font-size: 0.72rem;
  }

  .log-name {
    display: none; /* 紧凑屏优先保证 msg 可读 */
  }
}
</style>
