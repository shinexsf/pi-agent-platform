<script setup lang="ts">
/**
 * SessionInfoModal — displays full session information in a slide-out panel.
 *
 * Data source: GET /api/sessions/:id/session-info
 */
import { ref, onMounted, onUnmounted, computed } from 'vue'
import type { SessionInfoDTO } from '@pi-agent-platform/api-types'
import MarkdownView from './MarkdownView.vue'

const props = defineProps<{
  sessionId: string
}>()

const emit = defineEmits<{
  close: []
}>()

const loading = ref(true)
const error = ref<string | null>(null)
const info = ref<SessionInfoDTO | null>(null)
const systemPromptExpanded = ref(false)
/** Set of expanded resource item keys (format: "type:name") */
const expandedItems = ref(new Set<string>())

// ── 抽屉宽度拖拽 ──
// 把手在面板左缘，往左拖变宽。宽度存 localStorage，下次打开沿用。
const WIDTH_KEY = 'pi:session-info-panel-width'
const DEFAULT_PANEL_WIDTH = 420
const MIN_PANEL_WIDTH = 320
/** 右侧抽屉至少要给背景留出的宽度（点击遮罩关闭的命中区） */
const MIN_BACKDROP_WIDTH = 80

function maxPanelWidth(): number {
  return Math.max(MIN_PANEL_WIDTH, window.innerWidth - MIN_BACKDROP_WIDTH)
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(WIDTH_KEY)
    if (!raw) return DEFAULT_PANEL_WIDTH
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n)) return DEFAULT_PANEL_WIDTH
    return Math.min(maxPanelWidth(), Math.max(MIN_PANEL_WIDTH, n))
  } catch {
    return DEFAULT_PANEL_WIDTH
  }
}

const panelWidth = ref(readStoredWidth())
const resizing = ref(false)
let prevUserSelect = ''

function onResizeMove(e: MouseEvent) {
  const next = window.innerWidth - e.clientX
  panelWidth.value = Math.min(maxPanelWidth(), Math.max(MIN_PANEL_WIDTH, next))
}

function onResizeEnd() {
  resizing.value = false
  document.body.style.userSelect = prevUserSelect
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
  try {
    localStorage.setItem(WIDTH_KEY, String(panelWidth.value))
  } catch { /* localStorage 不可用就只保持本次会话 */ }
}

function onResizeStart(e: MouseEvent) {
  resizing.value = true
  // 拖动期间禁用文本选中，否则会一路选到面板里的 system prompt 文本
  prevUserSelect = document.body.style.userSelect
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', onResizeEnd)
  e.preventDefault()
}

/** 窗口变窄时把面板宽度收回合法区间 */
function onWindowResize() {
  panelWidth.value = Math.min(panelWidth.value, maxPanelWidth())
}

function toggleItem(key: string) {
  if (expandedItems.value.has(key)) {
    expandedItems.value.delete(key)
  } else {
    expandedItems.value.add(key)
  }
  // Force reactivity
  expandedItems.value = new Set(expandedItems.value)
}

function isExpanded(key: string): boolean {
  return expandedItems.value.has(key)
}

async function loadInfo() {
  loading.value = true
  error.value = null
  try {
    const res = await fetch(`/api/sessions/${props.sessionId}/session-info`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    info.value = await res.json()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function onBackdropClick(e: MouseEvent) {
  if (e.target === e.currentTarget) emit('close')
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

function formatUptime(ms: number): string {
  if (ms <= 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function formatTokens(n: number | null): string {
  if (n === null) return '—'
  return Math.round(n).toLocaleString('en-US')
}

const promptPreview = computed(() => {
  const text = info.value?.systemPrompt?.text
  if (!text) return '(not available)'
  return text.length > 500 ? text.slice(0, 500) + '…' : text
})

onMounted(() => {
  loadInfo()
  document.addEventListener('keydown', onKeyDown)
  window.addEventListener('resize', onWindowResize)
})

onUnmounted(() => {
  document.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('resize', onWindowResize)
  // 拖拽中卸载的兵底清理
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeEnd)
  document.body.style.userSelect = prevUserSelect
})
</script>

<template>
  <div class="modal-backdrop" @click="onBackdropClick">
    <div class="modal-panel" :style="{ width: panelWidth + 'px' }" @click.stop>
      <!-- 左缘拖拽把手：拖动改宽度 -->
      <div
        class="resize-handle"
        :class="{ active: resizing }"
        role="separator"
        aria-orientation="vertical"
        aria-label="Drag to resize panel"
        @mousedown="onResizeStart"
      />

      <div class="modal-header">
        <h3 class="modal-title">Session Info</h3>
        <button class="close-btn" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="modal-body">
        <div v-if="loading" class="loading-state">
          <span class="spinner" /> Loading…
        </div>

        <div v-else-if="error" class="error-state">
          {{ error }}
          <button class="retry-btn" @click="loadInfo">Retry</button>
        </div>

        <template v-else-if="info">
          <!-- ── Worker Info ── -->
          <div class="info-section">
            <div class="section-title">Worker</div>
            <div class="info-grid">
              <div class="info-row">
                <span class="info-label">PID</span>
                <span class="info-value">{{ info.workerPid > 0 ? info.workerPid : '—' }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Uptime</span>
                <span class="info-value">{{ formatUptime(info.uptimeMs) }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Model</span>
                <span class="info-value model-value">
                  {{ info.currentModel ? `${info.currentModel.provider}/${info.currentModel.modelId}` : '—' }}
                </span>
              </div>
              <div class="info-row">
                <span class="info-label">Thinking</span>
                <span class="info-value">{{ info.currentThinkingLevel ?? 'default' }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">CWD</span>
                <span class="info-value cwd-value" :title="info.cwd">{{ info.cwd || '—' }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Status</span>
                <span class="info-value">
                  <span :class="['status-badge', info.hasRow ? 'active' : 'placeholder']">
                    {{ info.hasRow ? 'active' : 'placeholder' }}
                  </span>
                </span>
              </div>
            </div>
          </div>

          <!-- ── Context Usage ── -->
          <div v-if="info.contextUsage" class="info-section">
            <div class="section-title">Context Window</div>
            <div class="info-grid">
              <div class="info-row">
                <span class="info-label">Used</span>
                <span class="info-value">{{ formatTokens(info.contextUsage.tokens) }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Limit</span>
                <span class="info-value">{{ formatTokens(info.contextUsage.contextWindow) }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Usage</span>
                <span class="info-value">
                  {{ info.contextUsage.percent !== null ? `${info.contextUsage.percent.toFixed(1)}%` : '—' }}
                </span>
              </div>
            </div>
          </div>

          <!-- ── System Prompt ── -->
          <div class="info-section">
            <div class="section-header" @click="systemPromptExpanded = !systemPromptExpanded">
              <span class="section-title section-title-row">
                <span>System Prompt</span>
                <span v-if="info.systemPrompt" class="section-meta">
                  {{ info.systemPrompt.length.toLocaleString() }} chars · {{ info.systemPrompt.source }}
                </span>
                <span v-else class="section-meta">not available</span>
              </span>
              <span class="expand-btn">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline :points="systemPromptExpanded ? '18 15 12 9 6 15' : '9 6 15 12 9 18'" />
                </svg>
              </span>
            </div>
            <div v-if="systemPromptExpanded && info.systemPrompt" class="system-prompt-content">
              <MarkdownView :source="info.systemPrompt.text" class="system-prompt-md" />
            </div>
            <div v-else-if="info.systemPrompt" class="system-prompt-preview" @click="systemPromptExpanded = true">
              {{ promptPreview }}
            </div>
          </div>

          <!-- ── Prompts ── -->
          <div v-if="info.resources.prompts.length > 0" class="info-section">
            <div class="section-title section-title-row">
              <span>Prompts</span>
              <span class="section-count">{{ info.resources.prompts.length }}</span>
            </div>
            <div class="resource-list">
              <div
                v-for="p in info.resources.prompts"
                :key="p.name"
                :class="['resource-item', { expanded: isExpanded(`prompt:${p.name}`) }]"
                @click="toggleItem(`prompt:${p.name}`)"
              >
                <span class="resource-name">{{ p.name }}</span>
                <template v-if="isExpanded(`prompt:${p.name}`)">
                  <span class="resource-full">{{ p.description }}</span>
                  <span class="resource-path">{{ p.filePath }}</span>
                </template>
                <span v-else class="resource-desc">{{ p.description }}</span>
              </div>
            </div>
          </div>

          <!-- ── Skills ── -->
          <div v-if="info.resources.skills.length > 0" class="info-section">
            <div class="section-title section-title-row">
              <span>Skills</span>
              <span class="section-count">{{ info.resources.skills.length }}</span>
            </div>
            <div class="resource-list">
              <div
                v-for="s in info.resources.skills"
                :key="s.name"
                :class="['resource-item', { expanded: isExpanded(`skill:${s.name}`) }]"
                @click="toggleItem(`skill:${s.name}`)"
              >
                <span class="resource-name">{{ s.name }}</span>
                <template v-if="isExpanded(`skill:${s.name}`)">
                  <span class="resource-full">{{ s.description }}</span>
                  <span class="resource-path">{{ s.filePath }}</span>
                </template>
                <span v-else class="resource-desc">{{ s.description }}</span>
              </div>
            </div>
          </div>

          <!-- ── Extensions ── -->
          <div v-if="info.resources.extensions.length > 0" class="info-section">
            <div class="section-title section-title-row">
              <span>Extensions</span>
              <span class="section-count">{{ info.resources.extensions.length }}</span>
            </div>
            <div class="resource-list">
              <div
                v-for="e in info.resources.extensions"
                :key="e.path"
                :class="['resource-item', { expanded: isExpanded(`ext:${e.name}`) }]"
                @click="toggleItem(`ext:${e.name}`)"
              >
                <span class="resource-name">{{ e.name }}</span>
                <template v-if="isExpanded(`ext:${e.name}`)">
                  <span class="resource-full">
                    {{ e.commandCount > 0 ? `${e.commandCount} command${e.commandCount > 1 ? 's' : ''}` : '' }}
                    {{ e.commandCount > 0 && e.toolCount > 0 ? '·' : '' }}
                    {{ e.toolCount > 0 ? `${e.toolCount} tool${e.toolCount > 1 ? 's' : ''}` : '' }}
                  </span>
                  <span class="resource-path">{{ e.path }}</span>
                </template>
                <span v-else class="resource-desc">
                  {{ e.commandCount > 0 ? `${e.commandCount} cmd${e.commandCount > 1 ? 's' : ''}` : '' }}
                  {{ e.commandCount > 0 && e.toolCount > 0 ? '·' : '' }}
                  {{ e.toolCount > 0 ? `${e.toolCount} tool${e.toolCount > 1 ? 's' : ''}` : '' }}
                </span>
              </div>
            </div>
          </div>

          <!-- ── Tools ── -->
          <div v-if="info.resources.tools.length > 0" class="info-section">
            <div class="section-title section-title-row">
              <span>Tools</span>
              <span class="section-count">{{ info.resources.tools.length }}</span>
            </div>
            <div class="resource-list">
              <div
                v-for="t in info.resources.tools"
                :key="t.name"
                :class="['resource-item', { expanded: isExpanded(`tool:${t.name}`) }]"
                @click="toggleItem(`tool:${t.name}`)"
              >
                <span class="resource-name">{{ t.name }}</span>
                <template v-if="isExpanded(`tool:${t.name}`)">
                  <span class="resource-full">{{ t.description }}</span>
                  <span class="resource-meta">
                    <span :class="['source-tag', t.sourceType]">{{ t.sourceType === 'builtin' ? 'builtin' : t.source }}</span>
                  </span>
                </template>
                <span v-else class="resource-desc">{{ t.description }}</span>
                <span v-if="!isExpanded(`tool:${t.name}`)" :class="['source-tag', t.sourceType]">{{ t.sourceType === 'builtin' ? 'builtin' : t.source }}</span>
              </div>
            </div>
          </div>

          <!-- No resources -->
          <div
            v-if="
              info.resources.prompts.length === 0
              && info.resources.skills.length === 0
              && info.resources.extensions.length === 0
              && info.resources.tools.length === 0
            "
            class="info-section"
          >
            <div class="section-title">Resources</div>
            <div class="empty-state">No prompts, skills, extensions, or tools loaded.</div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  justify-content: flex-end;
  z-index: 1000;
}

.modal-panel {
  position: relative;
  /* 宽度由 :style 内联控制（可拖拽）；这里只给默认值兼底 */
  width: 420px;
  max-width: calc(100vw - 80px);
  height: 100%;
  background: var(--bg-primary);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.2);
  animation: slide-in 0.2s ease-out;
}

/* 左缘拖拽把手 —— 6px 命中区，hover/拖动时显示一条强调色竖条 */
.resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 10;
}
.resize-handle::after {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: transparent;
  transition: background-color 0.15s;
}
.resize-handle:hover::after,
.resize-handle.active::after {
  background: var(--user-bubble-bg, #3574EF);
}

@keyframes slide-in {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.modal-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 0.15s;
}

.close-btn:hover {
  background: var(--hover-bg-strong);
  color: var(--text-primary);
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

/* ── Loading / Error ── */

.loading-state {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 13px;
  padding: 24px 0;
  justify-content: center;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--text-secondary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error-state {
  color: var(--tool-error-text, #ef4444);
  font-size: 13px;
  text-align: center;
  padding: 24px 0;
}

.retry-btn {
  display: inline-block;
  margin-top: 8px;
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
}

.retry-btn:hover {
  background: var(--hover-bg);
}

/* ── Sections ── */

.info-section {
  margin-bottom: 16px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.section-title-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.section-meta {
  font-size: 11px;
  color: var(--text-secondary);
  font-weight: 400;
  text-transform: none;
  letter-spacing: normal;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
  padding: 4px 0;
  margin-bottom: 8px;
}

.section-header:hover .section-title {
  color: var(--text-primary);
}

.expand-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--text-secondary);
  flex-shrink: 0;
  transition: background-color 0.15s;
}

.section-header:hover .expand-btn {
  background: var(--hover-bg-strong);
  color: var(--text-primary);
}

.section-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--hover-bg-strong);
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: none;
  letter-spacing: normal;
}

/* ── Info Grid ── */

.info-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.info-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  line-height: 1.6;
}

.info-label {
  color: var(--text-secondary);
  min-width: 60px;
  flex-shrink: 0;
}

.info-value {
  color: var(--text-primary);
  word-break: break-all;
}

.model-value {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px;
}

.cwd-value {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 280px;
}

.status-badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 500;
}

.status-badge.active {
  background: var(--tool-done-bg);
  color: var(--tool-done-text);
}

.status-badge.placeholder {
  background: var(--hover-bg-strong);
  color: var(--text-secondary);
}

/* ── System Prompt ── */

.system-prompt-content {
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  max-height: 400px;
  overflow-y: auto;
}

.system-prompt-md {
  padding: 12px;
  background: var(--hover-bg);
}

/* Override markdown-body styles inside system prompt for compact display */
.system-prompt-md :deep(.markdown-body) {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-primary);
  background: transparent;
  padding: 0;
  margin: 0;
}

.system-prompt-preview {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  padding: 8px 12px;
  background: var(--hover-bg);
  border-radius: 6px;
  max-height: 80px;
  overflow: hidden;
  cursor: pointer;
}

.system-prompt-preview:hover {
  color: var(--text-primary);
}

/* ── Resource Lists ── */

.resource-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.resource-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
  transition: background-color 0.1s;
}

.resource-item:hover {
  background: var(--hover-bg);
}

.resource-item.expanded {
  flex-wrap: wrap;
  background: var(--hover-bg);
}

.resource-name {
  color: var(--text-primary);
  font-weight: 500;
  flex-shrink: 0;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px;
}

.resource-desc {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.resource-full {
  color: var(--text-primary);
  width: 100%;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
}

.resource-path {
  color: var(--text-secondary);
  width: 100%;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 10px;
  opacity: 0.7;
}

.resource-meta {
  width: 100%;
  margin-top: 2px;
}

/* ── Source Tag (for tools) ── */

.source-tag {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 500;
  white-space: nowrap;
}

.source-tag.builtin {
  background: var(--tool-done-bg);
  color: var(--tool-done-text);
}

.source-tag.extension {
  background: var(--hover-bg-strong);
  color: var(--text-secondary);
}

.empty-state {
  color: var(--text-secondary);
  font-size: 12px;
  padding: 8px 0;
}
</style>
