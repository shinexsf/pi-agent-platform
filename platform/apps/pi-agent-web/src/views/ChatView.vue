<script setup lang="ts">
import { onMounted, onUnmounted, ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSSE } from '../composables/useSSE'
import { useAttachments } from '../composables/useAttachments'
import MessageList from '../components/chat/MessageList.vue'
import InputBox from '../components/chat/InputBox.vue'
import SteerSubBar from '../components/chat/SteerSubBar.vue'

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
    <div class="chat-container">
      <!-- 顶部状态栏 -->
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
          <!-- 关闭按钮 -->
          <button class="close-btn" title="关闭会话" @click="closeSession">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </header>

      <MessageList
        :messages="sse.messages.value"
        :sending="sse.sending.value"
        :agent-id="agentId"
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
  </div>
</template>

<style scoped>
.chat-page {
  display: flex;
  justify-content: center;
  min-height: 100dvh;
  background: var(--surface-subtle, #f5f5f5);
  padding: 24px 16px;
}

.chat-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 768px;
  height: calc(100dvh - 48px);
  background: var(--surface, #ffffff);
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 12px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  overflow: hidden;
}

/* 顶部状态栏 */
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border, #e5e5e5);
  background: var(--surface, #ffffff);
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
  .chat-page {
    padding: 0;
  }
  
  .chat-container {
    max-width: 100%;
    height: 100dvh;
    border-radius: 0;
    border: none;
  }

  .title-text {
    max-width: 150px;
  }

  .title-hint {
    display: none;
  }
}
</style>
