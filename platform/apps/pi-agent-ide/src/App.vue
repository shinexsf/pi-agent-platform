<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useSSE } from './composables/useSSE'
import { useIdeTheme } from './composables/useIdeTheme'
import { useAttachments } from './composables/useAttachments'
import MessageList from './components/MessageList.vue'
import InputBox from './components/InputBox.vue'
import SteerSubBar from './components/SteerSubBar.vue'

// 从 URL query 读取（JCEF loadURL 注入）
const sessionId = new URLSearchParams(location.search).get('sessionId') ?? ''
const agentId = new URLSearchParams(location.search).get('agentId') ?? ''

// SSE + context (commands + models + session) + history + steer
const sse = useSSE({ sessionId })

// User-attachment handler (Option A — cache 直传). Cache lives in this composable
// for the lifetime of the tab; closing the chat tab drops it. v1 has no
// persistent (IndexedDB) cache — performance/UX gap if a user uploads images
// then refreshes mid-flight; tracked as future work.
const attachments = useAttachments(
  { sessionId },
  {
    // Stub notifier: real toasts come when the IDE exposes a UI toast host.
    // For v1, console-only is fine — uploaded-then-attached never errors in
    // practice; uploads that fail are visible in DevTools.
    notify: (msg, level) => console[level === 'error' ? 'error' : 'warn'](`[attachments] ${msg}`),
  },
)

// 主题同步
const theme = useIdeTheme()
let unsubscribeTheme: (() => void) | null = null

async function handleSend(
  message: string,
  attachedImages?: Array<{ mimeType: string; data: string }>,
) {
  if (!agentId) {
    console.error('[App] agentId is missing')
    return
  }
  // useSSE.send() already calls loadContext() on success so the selectors refresh
  // after the placeholder is promoted to a real DB row.
  // attachedImages is from the InputBox useAttachments cache (Option A path).
  await sse.send(agentId, message, attachedImages)
}

onMounted(async () => {
  sse.subscribe()
  sse.subscribeToSteerQueue()
  await sse.loadHistory()
  // Single fetch populates commands + models + session metadata. Components
  // subscribe to specific fields via registerContextHandler() (see InputBox / selectors).
  await sse.loadContext()
  // Subscribe theme (Kotlin __applyIdeTheme global + Vue ref sync)
  unsubscribeTheme = theme.bindToBridge()
})

onUnmounted(() => {
  sse.unsubscribe()
  unsubscribeTheme?.()
})
</script>

<template>
  <!--
    跟旧插件一致：整个 chat tab 内容 = 一个 JCEF 占满，没有额外顶栏
    - 消息流占满顶部
    - Steer sub-bar (sending 时显示排队消息)
    - 输入框贴底（极简风格）
   -->
  <div class="chat-page">
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
      @set-thinking-level="(l: string) => sse.setThinkingLevel(l)"
    />
  </div>
</template>

<style scoped>
.chat-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--bg-primary);
  color: var(--text-primary);
}
</style>
