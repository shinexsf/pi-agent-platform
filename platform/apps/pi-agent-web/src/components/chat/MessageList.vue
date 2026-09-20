<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { MessageDTO } from '@pi-agent-platform/shared-types'
import MessageItem from './MessageItem.vue'
import TypingIndicator from './TypingIndicator.vue'

const props = defineProps<{
  messages: MessageDTO[]
  sending?: boolean
  agentId?: string
  fileAttachmentsByMsg?: Map<string, Array<{ attId: string; name: string; type: string }>>
}>()

const emit = defineEmits<{
  retry: [userMessageText: string, agentId: string]
  dismissError: [messageId: string]
}>()

const messagesEl = ref<HTMLElement | null>(null)
const autoScroll = ref(true)

/** Multiply per-notch scroll so chat reads like a chat, not a Telnet session.
 *  Chromium on Windows reports deltaMode=1 (LINE), 1 tick ≈ 1 line ≈ 16px.
 *  macOS natural-scroll inverts direction; user expectation is the same —
 *  scroll in the direction the wheel / trackpad pushes. */
const SCROLL_LINES_PER_TICK = 5

function onScroll() {
  const el = messagesEl.value
  if (!el) return
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  autoScroll.value = distance < 50
}

function onWheel(e: WheelEvent) {
  const el = messagesEl.value
  if (!el) return
  // If the wheel target is inside a scrollable child (e.g. .tool-result-block,
  // .arg-value-expanded, <pre>), let the browser handle it natively so the
  // inner scrollable gets the wheel event. Only intercept when the outer
  // message-list itself should scroll.
  const target = e.target as HTMLElement | null
  if (target) {
    let ancestor: HTMLElement | null = target
    while (ancestor && ancestor !== el) {
      const style = getComputedStyle(ancestor)
      if (
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        ancestor.scrollHeight > ancestor.clientHeight
      ) {
        // Inner element is scrollable and has overflow — let it scroll
        return
      }
      ancestor = ancestor.parentElement
    }
  }
  // Direct scrollTop +=: instant response, no animation queue (smooth scroll
  // on wheel ticks makes rapid scrolling stutter as each event cancels the
  // previous animation). Programmatic scroll (jump-to-latest, auto-follow new
  // messages) uses scrollTo({behavior: 'smooth'}) below.
  e.preventDefault()
  el.scrollTop += e.deltaY * SCROLL_LINES_PER_TICK
  onScroll()
}

onMounted(() => {
  messagesEl.value?.addEventListener('wheel', onWheel, { passive: false })
})

onBeforeUnmount(() => {
  messagesEl.value?.removeEventListener('wheel', onWheel)
})

function scrollToBottom(smooth = true) {
  const el = messagesEl.value
  if (!el) return
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  autoScroll.value = true
}

watch(
  () => {
    const last = props.messages[props.messages.length - 1]
    return {
      length: props.messages.length,
      content: last?.content ?? '',
      thinking: last?.thinking ?? '',
      // toolCalls 整体替换 + 内部 result streaming 都会变 — 没有这个字段的
      // 追踪，watch 在连续 toolcall 阶段根本不会触发，页面就停留在第一条
      // toolcall 出现之前的位置（典型症状：toolcall 跑完了页面才"突然"滚
      // 到 content 出来的那一行）。深 watch 确保 tc.result 增量更新也被捕到。
      toolCalls: last?.toolCalls ?? null,
    }
  },
  () => {
    if (!autoScroll.value) return
    // 'auto' 而不是 'smooth'：streaming 期间 scrollHeight 持续增长，smooth
    // 动画会被下一次 watch 触发的新 scrollTo 取消，从当前 scrollTop 重新
    // 启动 — 多次取消叠加后用户看到的就是"卡到一半"。即时跳则每次直接
    // 对齐当前 scrollHeight，体验是消息持续贴着底部走。
    nextTick(() => scrollToBottom(false))
  },
  { flush: 'post', deep: true },
)
</script>

<template>
  <div class="message-list-wrapper">
    <div
      ref="messagesEl"
      class="message-list"
      @scroll="onScroll"
    >
      <div v-if="messages.length === 0" class="empty-state">
        Send a message to start the conversation.
      </div>
      <MessageItem
        v-for="msg in messages"
        :key="msg.id"
        :message="msg"
        :agent-id="agentId"
        :file-attachments="fileAttachmentsByMsg?.get(msg.id)"
        @retry="(text: string, agentId: string) => emit('retry', text, agentId)"
        @dismiss-error="(id: string) => emit('dismissError', id)"
      />
      <!-- Typing indicator (per E2) -->
      <TypingIndicator v-if="sending" class="typing-indicator" />
    </div>
    <button
      v-if="!autoScroll"
      class="jump-to-latest"
      @click="scrollToBottom(true)"
    >
      ⬇ Jump to latest
    </button>
  </div>
</template>

<style scoped>
.message-list-wrapper {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
  display: flex;
  flex-direction: column;
}

.empty-state {
  color: var(--text-secondary);
  text-align: center;
  padding: 40px 20px;
  font-size: 13px;
}

.typing-indicator {
  margin-top: 8px;
}

.jump-to-latest {
  position: absolute;
  bottom: 12px;
  right: 12px;
  padding: 6px 12px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  cursor: pointer;
  font-size: 12px;
  box-shadow: var(--shadow-raised);
}

.jump-to-latest:hover {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}
</style>