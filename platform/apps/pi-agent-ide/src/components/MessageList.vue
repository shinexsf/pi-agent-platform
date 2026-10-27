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
  /** Older pages still exist server-side (change: session-streaming-runtime, 10.5). */
  hasMore?: boolean
  loadingOlder?: boolean
}>()

const emit = defineEmits<{
  retry: [userMessageText: string, agentId: string]
  dismissError: [messageId: string]
  loadOlder: []
}>()

const messagesEl = ref<HTMLElement | null>(null)
const autoScroll = ref(true)

/** 滚轮一格滚多少像素。
 *  Windows 的 Chromium 报 deltaMode=1（按行），一格通常是 3 行；macOS 触控板报
 *  deltaMode=0（按像素）。这里统一换算成像素，让一格在所有平台都约等于 3 行正文
 *  （≈78px）——原来直接乘 5 倍（100×5=500px，≈15 行）就是「一次跳一大截」的原因。 */
const WHEEL_PX_PER_LINE = 26

/** Distance from the top under which we start pulling the previous page. */
const LOAD_OLDER_THRESHOLD = 120

/** 系统开启「减少动态效果」时不做缓动，直接跟手。 */
const REDUCE_MOTION =
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * 平滑滚动的目标位置。滚轮每次只改这个目标值，由一条 rAF 循环把 scrollTop
 * 缓动过去 —— 关键在于「累加目标」而不是「每格各起一个动画」：快速连续拨轮
 * 时新事件只是把目标推得更远，循环一直在追，不会出现每格动画互相取消导致的
 * 卡顿/抖动。
 */
let wheelTarget = 0
let wheelRaf = 0

function onScroll() {
  const el = messagesEl.value
  if (!el) return
  // 没有动画在跑的时候（拖滚动条、键盘 PageUp/PageDown、程序化滚动），
  // 由原生滚动决定当前位置，把目标同步过来，避免下一次滚轮从旧目标跳回。
  if (!wheelRaf) wheelTarget = el.scrollTop
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  autoScroll.value = distance < 50
  if (el.scrollTop < LOAD_OLDER_THRESHOLD && props.hasMore && !props.loadingOlder) {
    prependAnchor = { height: el.scrollHeight, top: el.scrollTop }
    emit('loadOlder')
  }
}

/** 把滚轮增量统一换算成像素。 */
function wheelDeltaToPx(e: WheelEvent, el: HTMLElement): number {
  if (e.deltaMode === 1) {
    // 按行：至少算作一整行，避免某些驱动报 0.x 时一格几乎不动
    const lines = Math.sign(e.deltaY) * Math.max(1, Math.abs(e.deltaY))
    return lines * WHEEL_PX_PER_LINE
  }
  if (e.deltaMode === 2) return e.deltaY * el.clientHeight
  return e.deltaY
}

function stopWheelAnimation() {
  if (wheelRaf) {
    cancelAnimationFrame(wheelRaf)
    wheelRaf = 0
  }
  const el = messagesEl.value
  if (el) wheelTarget = el.scrollTop
}

/** 缓动循环：0.28 的系数在 60fps 下约 150ms 收敛 95%，跟手且不生硬。 */
function easeScrollTop() {
  const el = messagesEl.value
  if (!el) {
    wheelRaf = 0
    return
  }
  const max = el.scrollHeight - el.clientHeight
  if (wheelTarget > max) wheelTarget = max
  const remaining = wheelTarget - el.scrollTop
  if (Math.abs(remaining) < 0.5) {
    el.scrollTop = wheelTarget
    wheelRaf = 0
    onScroll()
    return
  }
  el.scrollTop += remaining * 0.28
  onScroll()
  wheelRaf = requestAnimationFrame(easeScrollTop)
}

/**
 * Scroll anchor for prepended pages: without it every older page shifts the
 * content the user is reading down by its own height (jumpy history).
 */
let prependAnchor: { height: number; top: number } | null = null

watch(
  () => props.messages.length,
  () => {
    const el = messagesEl.value
    if (!el || !prependAnchor) return
    const anchor = prependAnchor
    prependAnchor = null
    stopWheelAnimation()
    nextTick(() => {
      el.scrollTop = el.scrollHeight - anchor.height + anchor.top
      wheelTarget = el.scrollTop
    })
  },
)

function onWheel(e: WheelEvent) {
  const el = messagesEl.value
  if (!el) return
  // A child already consumed the wheel (e.g. a mermaid diagram in zoom mode):
  // respect it, otherwise the list scrolls by deltaY * SCROLL_LINES_PER_TICK and
  // fights the child for the same gesture.
  if (e.defaultPrevented) return
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
  // 增量归一化成像素后累加到目标位置，交给 rAF 缓动；不再直接 scrollTop +=。
  e.preventDefault()
  const delta = wheelDeltaToPx(e, el)
  const max = el.scrollHeight - el.clientHeight
  if (!wheelRaf) wheelTarget = el.scrollTop
  wheelTarget = Math.max(0, Math.min(max, wheelTarget + delta))
  if (REDUCE_MOTION) {
    el.scrollTop = wheelTarget
    onScroll()
    return
  }
  if (!wheelRaf) wheelRaf = requestAnimationFrame(easeScrollTop)
}

onMounted(() => {
  messagesEl.value?.addEventListener('wheel', onWheel, { passive: false })
})

onBeforeUnmount(() => {
  messagesEl.value?.removeEventListener('wheel', onWheel)
  if (wheelRaf) cancelAnimationFrame(wheelRaf)
})

function scrollToBottom(smooth = true) {
  const el = messagesEl.value
  if (!el) return
  // 程序化滚动接管：先掐掉滚轮缓动，避免两个动画抢 scrollTop
  stopWheelAnimation()
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
      <div v-if="loadingOlder" class="load-older-hint">Loading earlier messages…</div>
      <div v-else-if="hasMore" class="load-older-hint">Scroll up to load earlier messages</div>
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

.load-older-hint {
  padding: 6px 0 10px;
  text-align: center;
  font-size: 11px;
  color: var(--text-secondary);
  opacity: 0.7;
  user-select: none;
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
  background: var(--bg-primary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  cursor: pointer;
  font-size: 12px;
  box-shadow: var(--shadow-fab);
}

.jump-to-latest:hover {
  background: var(--user-bubble-bg);
  color: var(--user-bubble-text);
  border-color: var(--user-bubble-bg);
}
</style>