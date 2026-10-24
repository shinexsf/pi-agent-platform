<script setup lang="ts">
/**
 * SessionInfoModal (Web) — displays full session information in a modal dialog.
 *
 * Data source: GET /api/sessions/:id/session-info
 */
import { ref, onMounted, onUnmounted, computed } from 'vue'
import type { SessionInfoDTO } from '@pi-agent-platform/api-types'
import MarkdownView from './MarkdownView.vue'

const props = defineProps<{
  sessionId: string
  /**
   * Render as a plain panel instead of a modal: the chat page hosts session info
   * inside its resizable drawer, so the backdrop / close button / fixed sizing
   * must not come from here.
   */
  embedded?: boolean
}>()

const emit = defineEmits<{
  close: []
}>()

const loading = ref(true)
const error = ref<string | null>(null)
const info = ref<SessionInfoDTO | null>(null)
const systemPromptExpanded = ref(false)
const expandedItems = ref(new Set<string>())

function toggleItem(key: string) {
  if (expandedItems.value.has(key)) {
    expandedItems.value.delete(key)
  } else {
    expandedItems.value.add(key)
  }
  expandedItems.value = new Set(expandedItems.value)
}

function isExpanded(key: string): boolean {
  return expandedItems.value.has(key)
}

type ToolEntry = SessionInfoDTO['resources']['tools'][number]

/**
 * Badge text for the tool's origin: `builtin` (pi core tool), `platform` (registered by the
 * worker itself), otherwise the extension name — including pi's built-in extensions
 * (`mcp`, `codemode`, `tool-search`). There is no tool called `mcp`; it is the extension that
 * registers `mcp__<server>__<tool>`.
 */
function toolSourceLabel(t: ToolEntry): string {
  if (t.sourceType === 'sdk') return 'platform'
  return t.source || 'builtin'
}

/**
 * Whether the model cannot see the tool yet (`deferred` / `hidden` exposure).
 *
 * Rendered as dimming, not as text: `exposure` is pi metadata the user cannot change, so the
 * enum itself is noise (change: mcp-as-first-class-capability drops the `model-only` badge).
 */
function isLazy(t: { exposure: string }): boolean {
  return t.exposure === 'deferred' || t.exposure === 'hidden'
}

type McpServerEntry = SessionInfoDTO['resources']['mcpServers'][number]
type McpToolEntry = McpServerEntry['tools'][number]

/** `<server>` header for an MCP group; the resource-tools group is not a server. */
const mcpToolTotal = computed(() =>
  (info.value?.resources.mcpServers ?? []).reduce((sum, g) => sum + g.tools.length, 0),
)

/** Server name as configured in mcp.json (`rea`), not the tool prefix (`mcp__rea__`). */
function mcpGroupLabel(group: McpServerEntry): string {
  return group.kind === 'resources' ? '资源工具' : group.name
}

/** How many tools of a group are still unloaded (deferred / hidden). */
function mcpUnloadedCount(group: McpServerEntry): number {
  return group.tools.filter(isLazy).length
}

/** MCP groups start collapsed — one server alone can hold 100+ tools. */
const expandedMcp = ref(new Set<string>())

function toggleMcp(key: string) {
  if (expandedMcp.value.has(key)) expandedMcp.value.delete(key)
  else expandedMcp.value.add(key)
  expandedMcp.value = new Set(expandedMcp.value)
}

function isMcpExpanded(key: string): boolean {
  return expandedMcp.value.has(key)
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
})
onUnmounted(() => {
  document.removeEventListener('keydown', onKeyDown)
})
</script>

<template>
  <div
    :class="embedded ? 'info-embedded' : 'modal-backdrop'"
    @click="embedded ? undefined : onBackdropClick"
  >
    <div :class="embedded ? 'info-embedded-panel' : 'modal-panel'" @click.stop>
      <div v-if="!embedded" class="modal-header">
        <h3 class="modal-title">Session Info</h3>
        <button class="close-btn" @click="emit('close')">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div class="modal-body">
        <div v-if="loading" class="loading-state"><span class="spinner" /> Loading…</div>
        <div v-else-if="error" class="error-state">
          {{ error }}
          <button class="retry-btn" @click="loadInfo">Retry</button>
        </div>

        <template v-else-if="info">
          <!-- Worker -->
          <div class="info-section">
            <div class="section-title">Worker</div>
            <div class="info-grid">
              <div class="info-row"><span class="info-label">PID</span><span class="info-value">{{ info.workerPid > 0 ? info.workerPid : '—' }}</span></div>
              <div class="info-row"><span class="info-label">Uptime</span><span class="info-value">{{ formatUptime(info.uptimeMs) }}</span></div>
              <div class="info-row"><span class="info-label">Model</span><span class="info-value mono">{{ info.currentModel ? `${info.currentModel.provider}/${info.currentModel.modelId}` : '—' }}</span></div>
              <div class="info-row"><span class="info-label">Thinking</span><span class="info-value">{{ info.currentThinkingLevel ?? 'default' }}</span></div>
              <div class="info-row"><span class="info-label">CWD</span><span class="info-value mono cwd-val" :title="info.cwd">{{ info.cwd || '—' }}</span></div>
              <div class="info-row"><span class="info-label">Status</span><span class="info-value"><span :class="['badge', info.hasRow ? 'active' : 'ph']">{{ info.hasRow ? 'active' : 'placeholder' }}</span></span></div>
            </div>
          </div>

          <!-- Context -->
          <div v-if="info.contextUsage" class="info-section">
            <div class="section-title">Context Window</div>
            <div class="info-grid">
              <div class="info-row"><span class="info-label">Used</span><span class="info-value">{{ formatTokens(info.contextUsage.tokens) }}</span></div>
              <div class="info-row"><span class="info-label">Limit</span><span class="info-value">{{ formatTokens(info.contextUsage.contextWindow) }}</span></div>
              <div class="info-row"><span class="info-label">Usage</span><span class="info-value">{{ info.contextUsage.percent !== null ? `${info.contextUsage.percent.toFixed(1)}%` : '—' }}</span></div>
            </div>
          </div>

          <!-- System Prompt -->
          <div class="info-section">
            <div class="section-header" @click="systemPromptExpanded = !systemPromptExpanded">
              <span class="section-title row-title">
                <span>System Prompt</span>
                <span v-if="info.systemPrompt" class="section-meta">{{ info.systemPrompt.length.toLocaleString() }} chars · {{ info.systemPrompt.source }}</span>
                <span v-else class="section-meta">not available</span>
              </span>
              <span class="expand-btn">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline :points="systemPromptExpanded ? '18 15 12 9 6 15' : '9 6 15 12 9 18'" />
                </svg>
              </span>
            </div>
            <div v-if="systemPromptExpanded && info.systemPrompt" class="sp-content">
              <MarkdownView :source="info.systemPrompt.text" class="sp-md" />
            </div>
            <div v-else-if="info.systemPrompt" class="sp-preview" @click="systemPromptExpanded = true">{{ promptPreview }}</div>
          </div>

          <!-- Prompts -->
          <div v-if="info.resources.prompts.length > 0" class="info-section">
            <div class="section-title row-title"><span>Prompts</span><span class="section-count">{{ info.resources.prompts.length }}</span></div>
            <div class="res-list">
              <div v-for="p in info.resources.prompts" :key="p.name" :class="['res-item', { expanded: isExpanded(`prompt:${p.name}`) }]" @click="toggleItem(`prompt:${p.name}`)">
                <span class="res-name">{{ p.name }}</span>
                <template v-if="isExpanded(`prompt:${p.name}`)">
                  <span class="res-full">{{ p.description }}</span>
                  <span class="res-path">{{ p.filePath }}</span>
                </template>
                <span v-else class="res-desc">{{ p.description }}</span>
              </div>
            </div>
          </div>

          <!-- Skills -->
          <div v-if="info.resources.skills.length > 0" class="info-section">
            <div class="section-title row-title"><span>Skills</span><span class="section-count">{{ info.resources.skills.length }}</span></div>
            <div class="res-list">
              <div v-for="s in info.resources.skills" :key="s.name" :class="['res-item', { expanded: isExpanded(`skill:${s.name}`) }]" @click="toggleItem(`skill:${s.name}`)">
                <span class="res-name">{{ s.name }}</span>
                <template v-if="isExpanded(`skill:${s.name}`)">
                  <span class="res-full">{{ s.description }}</span>
                  <span class="res-path">{{ s.filePath }}</span>
                </template>
                <span v-else class="res-desc">{{ s.description }}</span>
              </div>
            </div>
          </div>

          <!-- Extensions -->
          <div v-if="info.resources.extensions.length > 0" class="info-section">
            <div class="section-title row-title"><span>Extensions</span><span class="section-count">{{ info.resources.extensions.length }}</span></div>
            <div class="res-list">
              <div v-for="e in info.resources.extensions" :key="e.path" :class="['res-item', { expanded: isExpanded(`ext:${e.name}`) }]" @click="toggleItem(`ext:${e.name}`)">
                <span class="res-name">{{ e.name }}</span>
                <template v-if="isExpanded(`ext:${e.name}`)">
                  <span class="res-full">
                    {{ e.commandCount > 0 ? `${e.commandCount} command${e.commandCount > 1 ? 's' : ''}` : '' }}
                    {{ e.commandCount > 0 && e.toolCount > 0 ? '·' : '' }}
                    {{ e.toolCount > 0 ? `${e.toolCount} tool${e.toolCount > 1 ? 's' : ''}` : '' }}
                  </span>
                  <span class="res-path">{{ e.path }}</span>
                </template>
                <span v-else class="res-desc">
                  {{ e.commandCount > 0 ? `${e.commandCount} cmd${e.commandCount > 1 ? 's' : ''}` : '' }}
                  {{ e.commandCount > 0 && e.toolCount > 0 ? '·' : '' }}
                  {{ e.toolCount > 0 ? `${e.toolCount} tool${e.toolCount > 1 ? 's' : ''}` : '' }}
                </span>
              </div>
            </div>
          </div>

          <!-- Tools -->
          <div v-if="info.resources.tools.length > 0" class="info-section">
            <div class="section-title row-title">
              <span>Tools</span>
              <span class="section-count">{{ info.resources.tools.length }}</span>
            </div>
            <div class="res-list">
              <div v-for="t in info.resources.tools" :key="t.name" :class="['res-item', { expanded: isExpanded(`tool:${t.name}`), lazy: isLazy(t) }]" @click="toggleItem(`tool:${t.name}`)">
                <span class="res-name">{{ t.name }}</span>
                <template v-if="isExpanded(`tool:${t.name}`)">
                  <span class="res-full">{{ t.description }}</span>
                  <span class="res-meta">
                    <span :class="['src-tag', t.sourceType]">{{ toolSourceLabel(t) }}</span>
                  </span>
                </template>
                <span v-else class="res-desc">{{ t.description }}</span>
                <span v-if="!isExpanded(`tool:${t.name}`)" class="res-tags">
                  <span :class="['src-tag', t.sourceType]">{{ toolSourceLabel(t) }}</span>
                </span>
              </div>
            </div>
          </div>

          <!-- MCP: separate section, grouped by server (change: mcp-as-first-class-capability) -->
          <div v-if="info.resources.mcpServers.length > 0" class="info-section">
            <div class="section-title row-title">
              <span>MCP</span>
              <span class="section-count">
                {{ info.resources.mcpServers.length }} 组 ·
                {{ mcpToolTotal }} 工具
              </span>
            </div>
            <div class="res-list">
              <div v-for="g in info.resources.mcpServers" :key="g.kind + ':' + g.name" class="mcp-group">
                <div :class="['res-item', 'mcp-group-head', { expanded: isMcpExpanded(g.kind + ':' + g.name) }]"
                  @click="toggleMcp(g.kind + ':' + g.name)">
                  <span class="res-name">{{ mcpGroupLabel(g) }}</span>
                  <span class="res-desc mcp-count">
                    {{ g.tools.length }} 工具<template v-if="mcpUnloadedCount(g) > 0">（{{ mcpUnloadedCount(g) }} 未加载）</template>
                  </span>
                </div>
                <div v-if="isMcpExpanded(g.kind + ':' + g.name)" class="res-list mcp-tools">
                  <div v-for="t in g.tools" :key="t.name" :class="['res-item', 'mcp-tool', { expanded: isExpanded(`mcp:${t.name}`), lazy: isLazy(t) }]"
                    @click.stop="toggleItem(`mcp:${t.name}`)">
                    <span class="res-name">{{ t.name }}</span>
                    <span v-if="isExpanded(`mcp:${t.name}`)" class="res-full">{{ t.description }}</span>
                    <span v-else class="res-desc">{{ t.description }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-if="info.resources.prompts.length === 0 && info.resources.skills.length === 0 && info.resources.extensions.length === 0 && info.resources.tools.length === 0 && info.resources.mcpServers.length === 0" class="info-section">
            <div class="section-title">Resources</div>
            <div class="empty-state">No prompts, skills, extensions, or tools loaded.</div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: center; justify-content: center; z-index: 1000; }
.modal-panel { width: 520px; max-width: 90vw; max-height: 85vh; background: var(--surface, #fff); border: 1px solid var(--border, #e5e5e5); border-radius: 12px; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,0.16); animation: mi 0.2s ease-out; }
@keyframes mi { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
.modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border, #e5e5e5); flex-shrink: 0; }
.modal-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--text, #1a1a1a); }
.close-btn { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: none; border-radius: 6px; background: transparent; color: var(--text-secondary, #666); cursor: pointer; }
.close-btn:hover { background: var(--surface-hover, #f5f5f5); color: var(--text, #1a1a1a); }
.modal-body { flex: 1; overflow-y: auto; padding: 20px; }

/* Embedded mode: the chat page's drawer owns the chrome (border, position,
   width, close button), so this component only supplies the scrolling body. */
.info-embedded { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.info-embedded-panel { display: flex; flex-direction: column; min-height: 0; flex: 1; }
.info-embedded .modal-body { padding: 12px 14px 18px; }

.loading-state { display: flex; align-items: center; gap: 8px; color: var(--text-secondary, #666); font-size: 13px; padding: 32px 0; justify-content: center; }
.spinner { width: 16px; height: 16px; border: 2px solid var(--border, #e5e5e5); border-top-color: var(--text-secondary, #666); border-radius: 50%; animation: spin 0.6s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.error-state { color: #ef4444; font-size: 13px; text-align: center; padding: 32px 0; }
.retry-btn { display: inline-block; margin-top: 8px; padding: 4px 12px; border: 1px solid var(--border, #e5e5e5); border-radius: 6px; background: transparent; color: var(--text, #1a1a1a); cursor: pointer; font-size: 12px; }
.retry-btn:hover { background: var(--surface-hover, #f5f5f5); }

.info-section { margin-bottom: 20px; }
.section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary, #666); margin-bottom: 8px; }
.row-title { display: flex; align-items: baseline; gap: 8px; }
.section-meta { font-size: 11px; color: var(--text-secondary, #666); font-weight: 400; text-transform: none; letter-spacing: normal; }
.section-header { display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; padding: 4px 0; margin-bottom: 8px; }
.section-header:hover .section-title { color: var(--text, #1a1a1a); }
.expand-btn { display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; border-radius: 4px; color: var(--text-secondary, #666); flex-shrink: 0; }
.section-header:hover .expand-btn { background: var(--surface-hover, #f5f5f5); color: var(--text, #1a1a1a); }
.section-count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--surface-hover, #f5f5f5); font-size: 10px; font-weight: 600; color: var(--text-secondary, #666); text-transform: none; letter-spacing: normal; }

.info-grid { display: flex; flex-direction: column; gap: 4px; }
.info-row { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 1.6; }
.info-label { color: var(--text-secondary, #666); min-width: 60px; flex-shrink: 0; }
.info-value { color: var(--text, #1a1a1a); word-break: break-all; }
.mono { font-family: var(--font-mono); font-size: 11px; }
.cwd-val { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 340px; }
.badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; font-weight: 500; }
.badge.active { background: #E8F5E9; color: #1B5E20; }
.badge.ph { background: var(--surface-hover, #f5f5f5); color: var(--text-secondary, #666); }

.sp-content { border: 1px solid var(--border, #e5e5e5); border-radius: 6px; overflow: hidden; max-height: 400px; overflow-y: auto; }
.sp-md { padding: 12px; background: var(--surface-subtle, #f9f9f9); }
.sp-md :deep(.markdown-body) { font-size: 11px; line-height: 1.5; color: var(--text, #1a1a1a); background: transparent; padding: 0; margin: 0; }
.sp-preview { font-family: var(--font-mono); font-size: 11px; line-height: 1.5; color: var(--text-secondary, #666); padding: 8px 12px; background: var(--surface-subtle, #f9f9f9); border-radius: 6px; max-height: 80px; overflow: hidden; cursor: pointer; }
.sp-preview:hover { color: var(--text, #1a1a1a); }

.res-list { display: flex; flex-direction: column; gap: 2px; }
.res-item { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border-radius: 4px; font-size: 12px; line-height: 1.5; cursor: pointer; transition: background-color 0.1s; }
.res-item:hover { background: var(--surface-hover, #f5f5f5); }
.res-item.expanded { flex-wrap: wrap; background: var(--surface-hover, #f5f5f5); }
.res-name { color: var(--text, #1a1a1a); font-weight: 500; flex-shrink: 0; font-family: var(--font-mono); font-size: 11px; }
.res-desc { color: var(--text-secondary, #666); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.res-full { color: var(--text, #1a1a1a); width: 100%; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
.res-path { color: var(--text-secondary, #666); width: 100%; font-family: var(--font-mono); font-size: 10px; opacity: 0.7; }
.res-meta { width: 100%; margin-top: 2px; }
.src-tag { flex-shrink: 0; font-size: 10px; padding: 1px 5px; border-radius: 3px; font-weight: 500; white-space: nowrap; }
.src-tag.builtin { background: #E8F5E9; color: #1B5E20; }
/* Any extension tool (pi built-in ones included: mcp / codemode / tool-search, or npm packages) */
.src-tag.extension { background: #E3F2FD; color: #0D47A1; }
.src-tag.sdk { background: #F3E5F5; color: #4A148C; }
.res-item.lazy .res-name { opacity: 0.55; }
.res-tags { flex-shrink: 0; display: inline-flex; gap: 4px; align-items: center; }
.mcp-group + .mcp-group { margin-top: 2px; }
.mcp-group-head { cursor: pointer; }
.mcp-count { font-variant-numeric: tabular-nums; }
.mcp-tools { margin: 2px 0 6px 14px; padding-left: 8px; border-left: 1px dashed var(--border); }
/* Registered but not loaded yet (tool_search hasn't pulled it in) */
.res-item.lazy .res-name, .res-item.lazy .res-desc { opacity: 0.55; }
.empty-state { color: var(--text-secondary, #666); font-size: 12px; padding: 8px 0; }
</style>
