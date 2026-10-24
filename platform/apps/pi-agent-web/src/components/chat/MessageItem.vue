<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MessageDTO } from '@pi-agent-platform/shared-types'
import MarkdownView from './MarkdownView.vue'
import ImageGrid from './ImageGrid.vue'
import { resolveToolBlock } from './tool-blocks'

const props = defineProps<{ message: MessageDTO; agentId?: string; fileAttachments?: Array<{ attId: string; name: string; type: string }> }>()
const emit = defineEmits<{
  retry: [userMessageText: string, agentId: string]
  dismissError: [messageId: string]
}>()

const isUser = computed(() => props.message.role === 'user')
const isError = computed(() => props.message.role === 'error')
const showCopyBtn = ref(false)

// ── User bubble long-message collapse ──
// User-sent messages can be arbitrarily long (logs, code dumps, multi-line
// prompts). Collapse the bubble to N lines with a toggle when the line count
// exceeds the threshold. State is per-message (keyed by id) — collapsing one
// doesn't affect siblings. Like thinking/toolresult, no streaming override:
// once a message is persisted it's already finalized.
const USER_BUBBLE_LINE_LIMIT = 10

const userBubbleExpanded = ref(new Set<string>())

const userLineCount = computed(() =>
  props.message.role === 'user'
    ? (props.message.content ?? '').split('\n').length
    : 0,
)

const userOverflow = computed(() => userLineCount.value > USER_BUBBLE_LINE_LIMIT)

const userBubbleExpandedNow = computed(() =>
  userBubbleExpanded.value.has(props.message.id),
)

const userDisplayContent = computed(() => {
  // Strip all <file> tags from user bubble — images render via ImageGrid,
  // non-image files have no visual representation yet (future: file card).
  const stripped = (props.message.content ?? '')
    .replace(/\s*<file\s[^>]*>[^<]*<\/file>\s*/g, ' ')
    .trim()
  if (!userOverflow.value) return stripped
  if (userBubbleExpandedNow.value) return stripped
  const lines = stripped.split('\n')
  return lines.slice(0, USER_BUBBLE_LINE_LIMIT).join('\n')
})

function toggleUserBubble() {
  if (userBubbleExpanded.value.has(props.message.id)) {
    userBubbleExpanded.value.delete(props.message.id)
  } else {
    userBubbleExpanded.value.add(props.message.id)
  }
  // Vue 3 ref+Set needs explicit re-assignment for reactivity.
  userBubbleExpanded.value = new Set(userBubbleExpanded.value)
}

// ── Collapse-when-done behavior for thinking + toolResult ──
// Each message has a runtime `__isStreaming` flag set by useSSE during SSE
// updates. While streaming, the row is force-expanded (user sees content
// being generated). After `message_end` the flag flips false → defaults to
// a single-line preview; click toggles to full view; click again collapses.
// Click handler is a no-op while streaming so the row can't be accidentally
// collapsed mid-generation.

const isStreaming = computed(() => Boolean((props.message as any).__isStreaming))

/**
 * Thinking collapse state (change: session-streaming-runtime, 9.3).
 *
 * `thinkingPinned` records a manual toggle: without it the block would re-collapse
 * the moment a run settles, throwing away the text the user just expanded.
 */
const thinkingExpanded = ref(false)
const thinkingPinned = ref(false)

/**
 * Tool calls + their resolved block binding (change: session-streaming-runtime).
 * Resolution happens once per render pass; each entry carries the label the
 * registry derived so the template does not call it repeatedly.
 */
const toolBlocks = computed(() =>
  (props.message.toolCalls ?? []).map((tc) => ({ tc, block: resolveToolBlock(tc.name) })),
)

const showThinkingExpanded = computed(() => thinkingExpanded.value || isStreaming.value)

/**
 * Single-line thinking (no newline) renders directly without any collapse
 * affordance — no point in folding a one-line block into a one-line block.
 * Only multi-line thinking gets the click-to-collapse preview.
 */
const thinkingIsMultiLine = computed(() => {
  const t = (props.message.thinking ?? '').trim()
  if (!t) return false
  return t.split('\n').filter((l) => l.trim().length > 0).length > 1
})

function toggleThinking() {
  if (isStreaming.value) return
  thinkingPinned.value = true
  thinkingExpanded.value = !thinkingExpanded.value
}

/**
 * Auto-collapse when the run settles (9.3): streaming forces the block open, and
 * on completion it folds back to the one-line preview unless the user pinned it.
 */
watch(
  () => isStreaming.value,
  (now, before) => {
    if (before && !now && !thinkingPinned.value) thinkingExpanded.value = false
  },
)

/**
 * File-path affordance inside the default tool card. The web host has no editor
 * to open files in (the IDE build renders its own card set), so this is a hook —
 * clicking a path must not throw.
 */
function openFile(_path: string) {
  /* ide-bridge only — see pi-agent-ide/src/components/chat */
}

/** Return the first non-empty line of a multi-line string for collapsed preview. */
function firstNonEmptyLine(s: string): string {
  const lines = s.replace(/^\s+|\s+$/g, '').split('\n')
  for (const line of lines) {
    if (line.trim().length > 0) return line
  }
  return ''
}


/** Copy entire assistant message content (no thinking / tool calls) to clipboard. */
async function copyMessage() {
  const text = props.message.content ?? ''
  try {
    await navigator.clipboard.writeText(text)
    showCopyBtn.value = false
    // brief feedback — re-show on next hover
  } catch {
    console.warn('[MessageItem] clipboard write failed')
  }
}

/** Download a file attachment by attId. */
async function downloadFile(attId: string, fileName: string) {
  // sessionId is the first path segment (URL: /:id or /web/:id)
  const segments = window.location.pathname.split('/').filter(Boolean)
  const sessionId = segments[segments.length - 1] // last segment is always sessionId
  if (!sessionId) return
  try {
    const res = await fetch(`/api/sessions/${sessionId}/attachments/${attId}`)
    if (!res.ok) return
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
  } catch { /* ignore */ }
}

</script>


<template>
  <!--
    Visual style matches old plugin JcefChatPanel LIGHT_CSS / DARK_CSS:
    - user message: blue bubble, no bottom-right radius, right-aligned
    - assistant message: no background, text + thinking + merged tool cards
    - tool call + result merged into single card (not split)
    - args shown as key-value (path clickable)
    - result inside card with max-height + scrollbar
  -->

  <!-- User 消息 -->
  <div v-if="isUser" class="message-user">
    <div class="message-user-bubble">
      <span class="message-user-text">{{ userDisplayContent }}</span>
      <!-- Render image attachments below the user bubble.
           Server-rendered (history) + client-attached (live useSSE.send)
           both reach this template with the same `message.images` shape. -->
      <ImageGrid
        v-if="message.images && message.images.length > 0"
        :images="message.images"
        variant="user"
      />
      <!-- Non-image file attachments -->
      <div v-if="fileAttachments && fileAttachments.length > 0" class="file-attachments">
        <button
          v-for="f in fileAttachments"
          :key="f.attId"
          type="button"
          class="file-card"
          @click="downloadFile(f.attId, f.name)"
        >
          <span class="file-icon">📄</span>
          <span class="file-name">{{ f.name }}</span>
          <span class="file-hint">点击下载</span>
        </button>
      </div>
      <button
        v-if="userOverflow"
        class="message-user-toggle"
        type="button"
        @click="toggleUserBubble"
      >
        {{ userBubbleExpandedNow
          ? '收起'
          : `展开剩余 ${userLineCount - USER_BUBBLE_LINE_LIMIT} 行` }}
      </button>
    </div>
  </div>

  <!-- Error 消息（per E1：插入聊天区中间） -->
  <div v-else-if="isError" class="message-error">
    <ErrorMessageItem
      :message="message"
      :agent-id="agentId ?? ''"
      @retry="(text: string, agentId: string) => emit('retry', text, agentId)"
      @dismiss="emit('dismissError', message.id)"
    />
  </div>

  <!-- Assistant 消息 -->
  <div v-else class="message-assistant" @mouseenter="showCopyBtn = true" @mouseleave="showCopyBtn = false">
    <!-- Hover Copy button (top-right) -->
    <button v-show="showCopyBtn" class="message-copy-btn" type="button" @click="copyMessage">Copy</button>

    <!-- Thinking：单行直接完整渲染（不折叠，省一个无意义的交互）；
          多行才走折叠预览 + click 切换；流式时强制展开。 -->
    <div v-if="message.thinking" class="thinking-area">
      <template v-if="thinkingIsMultiLine">
        <div
          v-if="!showThinkingExpanded"
          class="thinking-preview"
          @click="toggleThinking"
        >Thinking: {{ firstNonEmptyLine(message.thinking) }}<span class="thinking-collapsed-suffix">...(collapsed)</span></div>
        <div
          v-else
          class="thinking-expanded"
          @click="toggleThinking"
        >
          <MarkdownView :source="'Thinking: ' + message.thinking" class="message-thinking" />
        </div>
      </template>
      <MarkdownView
        v-else
        :source="'Thinking: ' + message.thinking"
        class="message-thinking"
      />
    </div>

    <!-- 主体内容：始终完整展示 -->
    <MarkdownView :source="message.content || ''" class="message-content" :streaming="isStreaming" />

    <!-- Tool calls：每张卡片由 tool-blocks 注册表解析（未知工具一律回落到默认卡片） -->
    <div v-if="toolBlocks.length > 0" class="message-toolcalls">
      <component
        :is="entry.block.component"
        v-for="entry in toolBlocks"
        :key="entry.tc.id"
        :call="entry.tc"
        :streaming="isStreaming"
        :label="entry.block.label"
        @open-file="openFile"
      />
    </div>
  </div>
</template>

<style scoped>
.message-user {
  display: flex;
  justify-content: flex-end;
  clear: both;
  /* Extra vertical padding separates user prompts from the surrounding agent
     turns (above: last tool card / message; below: next assistant turn).
     Assistant messages use 4px; user bubble needs more breathing room because
     its content is typically one logical unit the user wants to scan as a
     block. */
  padding: 8px 0 12px;
}

.message-user-bubble {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  max-width: 80%;
  background: var(--accent);
  color: white;
  border-radius: 12px 12px 12px 4px;
  padding: 8px 12px;
  /* The blue bubble now wraps text + image grid as a single visual unit.
     This matches what users expect from chat apps (Telegram/iMessage-style)
     and gives image thumbnails the same context as the text they were sent with. */
}

.message-user-text {
  display: block;
  /* No more background on the span — the bubble handles it now. */
  word-wrap: break-word;
  white-space: pre-wrap;
  text-align: left;
}

.message-user-toggle {
  background: transparent;
  border: none;
  color: white;
  opacity: 0.65;
  font-size: 11px;
  cursor: pointer;
  margin-top: 4px;
  padding: 0 12px;
  align-self: flex-end;
}
.message-user-toggle:hover {
  opacity: 1;
  text-decoration: underline;
}

/* File attachment cards */
.file-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.file-card {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  transition: background 0.15s;
  color: white;
  font-size: 13px;
}
.file-card:hover {
  background: rgba(255, 255, 255, 0.25);
}
.file-icon {
  font-size: 16px;
}
.file-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-hint {
  font-size: 11px;
  opacity: 0.6;
}

.message-assistant {
  position: relative;
  clear: both;
  padding: 4px 0;
}

.message-copy-btn {
  position: absolute;
  top: 2px;
  right: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text-secondary);
  cursor: pointer;
  z-index: 1;
}
.message-copy-btn:hover {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}

.message-thinking {
  color: var(--text-tertiary);
  font-size: 12.5px;
}

/* Thinking row: prototype style — faint text hung on a 2px left rule,
   collapsed to one line while running, expandable by click. */
.thinking-area {
  border-left: 2px solid var(--border-strong);
  padding: 2px 0 2px 10px;
  margin: 0 0 10px;
  font-size: 12.5px;
  color: var(--text-tertiary);
}
.thinking-area :deep(.message-thinking) {
  color: var(--text-tertiary);
  font-size: 12.5px;
}
.thinking-area :deep(.message-thinking p) {
  margin: 0 0 6px;
}
.thinking-area :deep(.message-thinking p:last-child) {
  margin-bottom: 0;
}
.thinking-preview {
  color: var(--text-tertiary);
  font-size: 12.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  user-select: none;
}
.thinking-collapsed-suffix {
  color: var(--text-tertiary);
  opacity: 0.7;
}
/* 折叠态末尾的 hyperlink-style 提示文字：链接色 + 下划线，仅作用于
 * `...(collapsed)` 这一段，整行其他文字保持灰色无下划线不变。
 * 用 var(--accent) 而不是硬编码 #93C5FD：后者在亮色白底上只有 2:1 对比度
 * 几乎不可见，跟 var(--accent) (4.5:1+) 一致。 */
.thinking-collapsed-suffix {
  color: var(--accent);
  text-decoration: underline;
  text-decoration-color: var(--accent);
  text-underline-offset: 2px;
}
.thinking-expanded {
  cursor: pointer;
  border-radius: 3px;
  padding: 2px 6px;
  margin: 0 -6px;
  /* No max-height per user request: full thinking stays fully visible. */
}
.thinking-expanded:hover {
  background: var(--surface-hover);
}

.message-content {
  /* no extra styling — MarkdownView handles typography */
}

.message-toolcalls {
  margin-top: 4px;
}

.message-error {
  clear: both;
  padding: 4px 0;
  display: flex;
  justify-content: flex-start;
}
</style>