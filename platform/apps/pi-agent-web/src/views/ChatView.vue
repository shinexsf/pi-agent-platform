<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSSE } from '../composables/useSSE'
import { useTheme } from '../composables/useTheme'
import { useAttachments } from '../composables/useAttachments'
import MessageList from '../components/chat/MessageList.vue'
import InputBox from '../components/chat/InputBox.vue'
import SteerSubBar from '../components/chat/SteerSubBar.vue'
import SessionInfoModal from '../components/chat/SessionInfoModal.vue'
const route = useRoute()
const router = useRouter()

// 从URL读取sessionId和agentId
const sessionId = ref(route.params.id as string)
const agentId = ref((route.query.agentId as string) ?? '')

// Session和Agent信息
const sessionTitle = ref<string>('')
const agentName = ref<string>('')
const isEditingTitle = ref(false)
const editingTitle = ref('')
const titleInputRef = ref<HTMLInputElement | null>(null)

// SSE + context (commands + models + session) + history + steer
const sse = useSSE({ sessionId: sessionId.value })

// Colour theme (header toggle; palette lives in style.css)
const { theme, toggle: toggleTheme } = useTheme()

/**
 * Authoritative "a turn is running" for the chat UI (change: session-streaming-runtime).
 * `sse.sending` remains optimistic UI only; this merges it so a stale local flag
 * never hides the stop button while the worker is actually running.
 */
const isRunning = computed(() => sse.run.running.value || sse.sending.value)

// User-attachment handler
const attachments = useAttachments(
  { sessionId: sessionId.value },
  {
    notify: (msg, level) => {
      console[level === 'error' ? 'error' : 'warn'](`[attachments] ${msg}`)
    },
  },
)

// Session info panel (rendered inside the drawer)
export type ChatDrawerTab = 'run' | 'context' | 'info'

/** Drawer titles per tab (the drawer header is shared). */
const DRAWER_TITLES: Record<ChatDrawerTab, string> = {
  run: '运行状态',
  context: '上下文',
  info: '会话信息',
}

/**
 * Right-edge drawer (change: session-streaming-runtime, 8.3/8.4).
 *
 * The rail itself never occupies layout width — it floats over the right gutter
 * (IDE-style, semi-transparent until hover) and the drawer slides OVER the
 * content column instead of squeezing it, so the 860px reading measure is stable
 * whether the drawer is open or closed. The drawer width is user-resizable by
 * dragging its left edge and is remembered across sessions.
 */
const drawerTab = ref<ChatDrawerTab | null>(null)

const DRAWER_WIDTH_KEY = 'pi-agent:chat-drawer-width'
const DRAWER_MIN_WIDTH = 280
const DRAWER_MAX_WIDTH = 760

function initialDrawerWidth(): number {
  const stored = Number(window.localStorage.getItem(DRAWER_WIDTH_KEY))
  if (Number.isFinite(stored) && stored >= DRAWER_MIN_WIDTH && stored <= DRAWER_MAX_WIDTH) {
    return stored
  }
  return 380
}

const drawerWidth = ref(initialDrawerWidth())
const resizingDrawer = ref(false)

function startDrawerResize(e: MouseEvent) {
  e.preventDefault()
  resizingDrawer.value = true
  const startX = e.clientX
  const startWidth = drawerWidth.value

  // The drawer is anchored to the right edge, so dragging left (smaller clientX)
  // must make it wider.
  function onMove(ev: MouseEvent) {
    const next = startWidth + (startX - ev.clientX)
    drawerWidth.value = Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, next))
  }

  function onUp() {
    resizingDrawer.value = false
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
    document.body.style.userSelect = ''
    window.localStorage.setItem(DRAWER_WIDTH_KEY, String(drawerWidth.value))
  }

  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

function toggleDrawer(tab: ChatDrawerTab) {
  drawerTab.value = drawerTab.value === tab ? null : tab
}

function closeDrawer() {
  drawerTab.value = null
}

/** Context-window usage for the drawer's context tab (null until first load). */
const contextUsage = computed(() => sse.contextCache.value?.contextUsage ?? null)

/** Last assistant message that carries usage (for the run tab). */
const lastUsage = computed(() => {
  const msgs = sse.messages.value
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const u = msgs[i]?.usage
    if (u) return u
  }
  return null
})

function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString()
}

function formatDuration(ms: number | null): string {
  if (!ms || ms < 0) return '—'
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

// 显示的标题
const displayTitle = computed(() => {
  return sessionTitle.value || `Session ${sessionId.value.slice(0, 8)}`
})

// 加载session和agent信息
async function loadSessionInfo() {
  try {
    // 加载session信息
    const sessionRes = await fetch(`/api/sessions/${sessionId.value}`)
    if (sessionRes.ok) {
      const session = await sessionRes.json()
      sessionTitle.value = session.title || ''
      if (session.agentId && !agentId.value) {
        agentId.value = session.agentId
      }
    }
    
    // 加载agent信息
    if (agentId.value) {
      const agentRes = await fetch(`/api/agents/${agentId.value}`)
      if (agentRes.ok) {
        const agent = await agentRes.json()
        agentName.value = agent.name || ''
      }
    }
  } catch (err) {
    console.warn('[ChatView] loadSessionInfo failed:', err)
  }
}

// 开始编辑标题
function startEditTitle() {
  editingTitle.value = sessionTitle.value
  isEditingTitle.value = true
  setTimeout(() => {
    titleInputRef.value?.focus()
    titleInputRef.value?.select()
  }, 50)
}

// 保存标题
async function saveTitle() {
  const newTitle = editingTitle.value.trim()
  if (newTitle === sessionTitle.value) {
    isEditingTitle.value = false
    return
  }
  
  try {
    const res = await fetch(`/api/sessions/${sessionId.value}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle || undefined }),
    })
    if (res.ok) {
      sessionTitle.value = newTitle
    }
  } catch (err) {
    console.error('[ChatView] rename failed:', err)
  }
  
  isEditingTitle.value = false
}

// 取消编辑
function cancelEditTitle() {
  isEditingTitle.value = false
}

// 关闭session
async function closeSession() {
  if (!confirm('确定要关闭这个会话吗？Worker将被停止。')) {
    return
  }
  
  try {
    await fetch(`/api/sessions/${sessionId.value}/close`, { method: 'POST' })
  } catch (err) {
    console.error('[ChatView] close failed:', err)
  }
  
  // 关闭标签页
  window.close()
}

async function handleSend(
  message: string,
  attachedImages?: Array<{ mimeType: string; data: string }>,
) {
  if (!agentId.value) {
    console.error('[ChatView] agentId is missing')
    return
  }
  await sse.send(agentId.value, message, attachedImages)
}

onMounted(async () => {
  await loadSessionInfo()
  sse.subscribe()
  sse.subscribeToSteerQueue()
  await sse.loadHistory()
  await sse.loadContext()
})

onUnmounted(() => {
  sse.unsubscribe()
})
</script>

<template>
  <div class="chat-page">
    <!-- 顶部状态栏 —— 整页宽，独立于会话内容 -->
    <header class="chat-header">
     <div class="header-inner">
      <div class="header-left">
        <!-- 会话名称 -->
        <div v-if="!isEditingTitle" class="title-display" @dblclick="startEditTitle">
          <span class="title-text">{{ displayTitle }}</span>
          <span class="title-hint">双击编辑</span>
        </div>
        <input
          v-else
          ref="titleInputRef"
          v-model="editingTitle"
          class="title-input"
          type="text"
          maxlength="200"
          placeholder="输入会话名称..."
          @blur="saveTitle"
          @keydown.enter="saveTitle"
          @keydown.escape="cancelEditTitle"
        />
        <!-- Agent名称 -->
        <span v-if="agentName" class="agent-name">{{ agentName }}</span>
      </div>
      <div class="header-right">
        <!-- 主题切换：亮 / 暗（存 localStorage，首次跟系统） -->
        <button
          class="theme-btn"
          type="button"
          :title="theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'"
          @click="toggleTheme"
        >
          <svg
            v-if="theme === 'dark'"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          >
            <circle cx="12" cy="12" r="4.2" />
            <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
          </svg>
          <svg
            v-else
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          >
            <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z" />
          </svg>
        </button>
        <!-- 连接状态 -->
        <span :class="['status-dot', sse.connected.value ? 'connected' : 'disconnected']"></span>
        <!-- 关闭按钮 -->
        <button class="close-btn" title="关闭会话" @click="closeSession">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
     </div>
    </header>

    <!-- 会话内容区 —— 全宽容器（滚动条贴窗口右缘），限宽下沉到内容层 -->
    <div class="chat-body">
      <!-- 右侧 icon 轨道：不占布局宽度，浮在右侧留白上（IDE 风） -->
      <aside class="chat-rail" :class="{ 'rail-active': drawerTab !== null }">
        <button
          class="rail-btn"
          :class="{ active: drawerTab === 'run' }"
          type="button"
          title="运行状态"
          @click="toggleDrawer('run')"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 12h4l2.5-6 4 12 2.5-6h5" />
          </svg>
        </button>
        <button
          class="rail-btn"
          :class="{ active: drawerTab === 'context' }"
          type="button"
          title="上下文"
          @click="toggleDrawer('context')"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 12V7" />
            <path d="M12 12l3.5 2" />
          </svg>
        </button>
        <button
          class="rail-btn"
          :class="{ active: drawerTab === 'info' }"
          type="button"
          title="会话信息"
          @click="toggleDrawer('info')"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        </button>
      </aside>

      <!-- 右侧抽屉：盖在内容上方（不挤压读宽） -->
      <transition name="drawer">
        <section
          v-if="drawerTab !== null"
          class="chat-drawer"
          :class="{ 'drawer-resizing': resizingDrawer }"
          :style="{ width: drawerWidth + 'px' }"
          @keydown.escape="closeDrawer"
        >
          <div
            class="drawer-resize"
            role="separator"
            aria-orientation="vertical"
            title="拖动调整宽度"
            @mousedown="startDrawerResize"
          />
          <header class="drawer-head">
            <span class="drawer-title">{{ DRAWER_TITLES[drawerTab] }}</span>
            <button class="drawer-close" type="button" title="关闭" @click="closeDrawer">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </header>

          <SessionInfoModal
            v-if="drawerTab === 'info'"
            :session-id="sessionId"
            embedded
          />

          <div v-if="drawerTab === 'run'" class="drawer-body">
            <div class="drawer-row">
              <span class="drawer-key">状态</span>
              <span class="drawer-val" :class="sse.run.running.value ? 'val-running' : 'val-idle'">
                {{ sse.run.running.value ? '运行中' : '空闲' }}
              </span>
            </div>
            <div class="drawer-row">
              <span class="drawer-key">已用时</span>
              <span class="drawer-val">{{ formatDuration(sse.run.elapsedMs.value) }}</span>
            </div>
            <div class="drawer-row">
              <span class="drawer-key">待处理 steer</span>
              <span class="drawer-val">{{ sse.run.pendingSteer.value }}</span>
            </div>
            <div class="drawer-row">
              <span class="drawer-key">待处理 follow-up</span>
              <span class="drawer-val">{{ sse.run.pendingFollowUp.value }}</span>
            </div>
            <div class="drawer-sep" />
            <div class="drawer-row">
              <span class="drawer-key">最近用量</span>
              <span class="drawer-val">{{ lastUsage ? '有' : '—' }}</span>
            </div>
            <template v-if="lastUsage">
              <div class="drawer-row drawer-sub">
                <span class="drawer-key">input / output</span>
                <span class="drawer-val">{{ formatTokens(lastUsage.input) }} / {{ formatTokens(lastUsage.output) }}</span>
              </div>
              <div class="drawer-row drawer-sub">
                <span class="drawer-key">cache read / write</span>
                <span class="drawer-val">{{ formatTokens(lastUsage.cacheRead) }} / {{ formatTokens(lastUsage.cacheWrite) }}</span>
              </div>
            </template>
          </div>

          <div v-else-if="drawerTab === 'context'" class="drawer-body">
            <div class="drawer-row">
              <span class="drawer-key">已用上下文</span>
              <span class="drawer-val">{{ formatTokens(contextUsage?.tokens) }}</span>
            </div>
            <div class="drawer-row">
              <span class="drawer-key">窗口上限</span>
              <span class="drawer-val">{{ formatTokens(contextUsage?.contextWindow) }}</span>
            </div>
            <div class="drawer-row">
              <span class="drawer-key">占比</span>
              <span class="drawer-val">{{ contextUsage?.percent === null || contextUsage?.percent === undefined ? '—' : `${Math.round(contextUsage.percent)}%` }}</span>
            </div>
            <div class="drawer-bar">
              <div class="drawer-bar-fill" :style="{ width: `${Math.max(0, Math.min(100, contextUsage?.percent ?? 0))}%` }" />
            </div>
            <div class="drawer-note">百分比为 SDK 估算值；压缩（compaction）刚发生时可能暂为未知。</div>
          </div>
        </section>
      </transition>

      <MessageList
        :messages="sse.messages.value"
        :sending="isRunning"
        :agent-id="agentId"
        :file-attachments-by-msg="sse.fileAttachmentsByMsg.value"
        :has-more="sse.historyHasMore.value"
        :loading-older="sse.loadingOlder.value"
        @load-older="sse.loadOlder"
        @retry="(text: string, aid: string) => sse.retry(text, aid)"
        @dismiss-error="(id: string) => sse.clearError(id)"
      />
      <!-- 底部区（steer + 输入框）保持 768 居中，与消息内容列对齐 -->
      <div class="chat-footer">
        <SteerSubBar
          :steering="sse.steeringQueue.value"
        />
        <InputBox
          :session-id="sessionId"
          :agent-id="agentId"
          :disabled="!sse.connected.value"
          :sending="isRunning"
          :usage="lastUsage"
          :attachments-uploader="attachments"
          @send="handleSend"
          @abort="sse.abort"
          @dispatch-command="(name: string, args: string) => sse.dispatchCommand(name, args)"
          @set-model="(p: string, m: string) => sse.setModel(p, m)"
          @set-thinking-level="(l: 'off' | 'low' | 'medium' | 'high') => sse.setThinkingLevel(l)"
        />
      </div>
    </div>

  </div>
</template>

<style scoped>
/* 整体页面：占满视口，纵向 flex。
 * 注意：chat 页不走 AppShell（App.vue 里 isChatPage 分支直接渲染 router-view），
 * 所以没有 .app-main 提供确定高度 —— 这里必须用 100dvh 而不是 height:100%。
 * 字号基准比全局小一档 —— 消息内容（markdown-body 无显式 font-size）
 * 从这里继承，因此整体比全局小一档（16px → 15px）。 */
.chat-page {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
  font-size: 15px;
  /* 用 --bg（页面背景）而不是 --surface：会话区不再是白卡片，
   * 而是与整页背景同一色 → 无边框、无阴影的“融为一体”效果。 */
  background: var(--bg, #f4f6f9);
  color: var(--text, #1a1a1a);
}

/* 顶部标题栏 —— 整页宽（背景/分隔线），内层 860 居中与内容列对齐 */
.chat-header {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  width: 100%;
  height: 48px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border, #e5e5e5);
  background: var(--surface, #ffffff);
}

/* 页头是页面级 chrome（不是会话内容）：横跨整页、左右贴边，
 * 不受内容列 860px 约束 —— 内容限宽只作用于消息列与输入框。 */
.header-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.theme-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.theme-btn:hover {
  background: var(--surface-hover);
  color: var(--text);
}

/* 会话内容区 —— 全宽（不再限宽居中）：滚动条属于窗口，紧贴右缘。
 * 限宽下沉到两层内容：
 *   - MessageList 内部 .messages-column（768 居中，消息可读宽度不变）
 *   - .chat-footer（steer + 输入框，768 居中，与消息列对齐） */
/* 会话内容区 —— 全宽容器（滚动条贴窗口右缘），限宽下沉到内容层。
 * position: relative 让右侧 icon 轨道与抽屉能相对它绝对定位（轨道/抽屉不占布局宽度）。 */
.chat-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow: hidden;
  position: relative;
}

/* ── 右侧 icon 轨道（IDE 风）：浮在右侧留白上、平时半透明、不挤压内容 ── */
.chat-rail {
  position: absolute;
  top: 8px;
  right: 6px;
  /* Above the drawer on purpose: the rail must stay clickable while a drawer is
   * open, so switching tabs (or closing) never requires hitting the drawer body. */
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  border-radius: 10px;
  opacity: 0.38;
  transition: opacity 0.18s ease;
}

.chat-rail:hover,
.chat-rail.rail-active {
  opacity: 1;
  background: color-mix(in srgb, var(--surface, #fff) 78%, transparent);
  box-shadow: 0 2px 10px rgb(0 0 0 / 0.08);
}

.rail-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.rail-btn:hover {
  background: var(--surface-hover, #f3f4f6);
  color: var(--text, #111827);
}

.rail-btn.active {
  background: color-mix(in srgb, var(--accent, #3b82f6) 14%, transparent);
  color: var(--accent, #3b82f6);
}

/* ── 右侧抽屉：盖在内容上方，不挤压 860px 读宽 ── */
.chat-drawer {
  position: absolute;
  top: 0;
  /* Leaves the 44px gutter that hosts the icon rail, so the rail stays visible
   * and clickable while the drawer is open (IDE activity-bar behavior). */
  right: 44px;
  bottom: 0;
  z-index: 20;
  /* width comes from the resizable state (inline style) */
  min-width: 280px;
  max-width: 82vw;
  display: flex;
  flex-direction: column;
  background: var(--surface, #fff);
  border-left: 1px solid var(--border, #e5e7eb);
  box-shadow: -8px 0 24px rgb(0 0 0 / 0.06);
}

/* Left-edge resize handle: a 6px strip straddling the drawer border. */
.drawer-resize {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -3px;
  width: 6px;
  cursor: col-resize;
  z-index: 1;
}

.drawer-resize:hover,
.chat-drawer.drawer-resizing .drawer-resize {
  background: var(--accent, #3b82f6);
  opacity: 0.45;
}

.chat-drawer.drawer-resizing {
  user-select: none;
}

.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 42px;
  padding: 0 12px 0 14px;
  border-bottom: 1px solid var(--border, #e5e7eb);
  flex-shrink: 0;
}

.drawer-title {
  font-size: 13px;
  font-weight: 650;
  color: var(--text, #111827);
}

.drawer-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, #6b7280);
  cursor: pointer;
}

.drawer-close:hover {
  background: var(--surface-hover, #f3f4f6);
}

.drawer-body {
  padding: 12px 14px;
  overflow-y: auto;
  font-size: 13px;
}

.drawer-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 5px 0;
}

.drawer-key {
  color: var(--text-secondary, #6b7280);
  white-space: nowrap;
}

.drawer-val {
  color: var(--text, #111827);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.drawer-val.val-running { color: var(--accent, #2563eb); font-weight: 600; }
.drawer-val.val-idle { color: var(--text-secondary, #6b7280); }

.drawer-sub .drawer-key { font-size: 12px; padding-left: 8px; }
.drawer-sub .drawer-val { font-size: 12px; }

.drawer-sep {
  height: 1px;
  margin: 8px 0;
  background: var(--border, #e5e7eb);
}

.drawer-bar {
  height: 6px;
  margin: 10px 0 8px;
  border-radius: 999px;
  background: var(--surface-hover, #f3f4f6);
  overflow: hidden;
}

.drawer-bar-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--accent, #3b82f6);
  transition: width 0.25s ease;
}

.drawer-note {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-secondary, #6b7280);
}

/* 抽屉进出场：从右侧滑入 */
.drawer-enter-active,
.drawer-leave-active { transition: transform 0.18s ease, opacity 0.18s ease; }
.drawer-enter-from,
.drawer-leave-to { transform: translateX(12px); opacity: 0; }

.chat-footer {
  width: 100%;
  max-width: 860px;
  margin: 0 auto;
  flex-shrink: 0;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex: 1;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

/* 会话名称 */
.title-display {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: background-color 0.15s;
}

.title-display:hover {
  background: var(--surface-hover, #f5f5f5);
}

.title-text {
  font-size: 14px;
  font-weight: 600;
  color: var(--text, #1a1a1a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 300px;
}

.title-hint {
  font-size: 11px;
  color: var(--text-secondary, #666);
  opacity: 0;
  transition: opacity 0.15s;
}

.title-display:hover .title-hint {
  opacity: 1;
}

.title-input {
  font-size: 14px;
  font-weight: 600;
  color: var(--text, #1a1a1a);
  padding: 4px 8px;
  border: 1px solid var(--accent, #3b82f6);
  border-radius: 6px;
  outline: none;
  background: var(--surface, #ffffff);
  min-width: 200px;
  max-width: 300px;
}

/* Agent名称 */
.agent-name {
  font-size: 12px;
  color: var(--text-secondary, #666);
  padding: 2px 8px;
  background: var(--surface-hover, #f5f5f5);
  border-radius: 4px;
}

/* 连接状态点 */
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.status-dot.connected {
  background: #10b981;
}

.status-dot.disconnected {
  background: #ef4444;
}

/* Session Info 按钮 */
.info-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, #666);
  cursor: pointer;
  transition: all 0.15s;
}

.info-btn:hover {
  background: var(--surface-hover, #f5f5f5);
  color: var(--text, #1a1a1a);
}

/* 关闭按钮 */
.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary, #666);
  cursor: pointer;
  transition: all 0.15s;
}

.close-btn:hover {
  background: var(--danger-soft, #fee2e2);
  color: var(--danger, #ef4444);
}

@media (max-width: 768px) {
  .chat-header {
    padding: 0 12px;
  }

  .chat-footer {
    max-width: 100%;
  }

  .title-text {
    max-width: 150px;
  }

  .title-hint {
    display: none;
  }
}
</style>
