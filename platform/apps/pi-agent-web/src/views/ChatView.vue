<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSSE } from '../composables/useSSE'
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

// User-attachment handler
const attachments = useAttachments(
  { sessionId: sessionId.value },
  {
    notify: (msg, level) => {
      console[level === 'error' ? 'error' : 'warn'](`[attachments] ${msg}`)
    },
  },
)

// Session info modal
const showSessionInfo = ref(false)

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
        <!-- 连接状态 -->
        <span :class="['status-dot', sse.connected.value ? 'connected' : 'disconnected']"></span>
        <!-- Session Info -->
        <button class="info-btn" title="Session Info" @click="showSessionInfo = true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        </button>
        <!-- 关闭按钮 -->
        <button class="close-btn" title="关闭会话" @click="closeSession">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </header>

    <!-- 会话内容区 —— 无边框，与背景融合 -->
    <div class="chat-body">
      <MessageList
        :messages="sse.messages.value"
        :sending="sse.sending.value"
        :agent-id="agentId"
        :file-attachments-by-msg="sse.fileAttachmentsByMsg.value"
        @retry="(text: string, aid: string) => sse.retry(text, aid)"
        @dismiss-error="(id: string) => sse.clearError(id)"
      />
      <SteerSubBar
        :steering="sse.steeringQueue.value"
      />
      <InputBox
        :session-id="sessionId"
        :agent-id="agentId"
        :disabled="!sse.connected.value"
        :sending="sse.sending.value"
        :attachments-uploader="attachments"
        @send="handleSend"
        @abort="sse.abort"
        @dispatch-command="(name: string, args: string) => sse.dispatchCommand(name, args)"
        @set-model="(p: string, m: string) => sse.setModel(p, m)"
        @set-thinking-level="(l: 'off' | 'low' | 'medium' | 'high') => sse.setThinkingLevel(l)"
      />
    </div>

    <!-- Session Info Modal -->
    <SessionInfoModal
      v-if="showSessionInfo"
      :session-id="sessionId"
      @close="showSessionInfo = false"
    />
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

/* 顶部标题栏 —— 整页宽，属于页面级 chrome，不属于会话内容 */
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  width: 100%;
  height: 48px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border, #e5e5e5);
  background: var(--surface, #ffffff);
}

/* 会话内容区 —— 无边框/无卡片，直接坐在页面背景上；
 * 内容居中限宽，输入框贴底。 */
.chat-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  width: 100%;
  max-width: 768px;
  margin: 0 auto;
  overflow: hidden;
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

  .chat-body {
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
