<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MessageDTO } from '@pi-agent-platform/shared-types'
import { useIdeBridge } from '../composables/useIdeBridge'
import { Methods } from '../bridge/methods'
import MarkdownView from './MarkdownView.vue'
import ErrorMessageItem from './ErrorMessageItem.vue'
import ImageGrid from './ImageGrid.vue'

const props = defineProps<{ message: MessageDTO; agentId?: string }>()
const emit = defineEmits<{
  retry: [userMessageText: string, agentId: string]
  dismissError: [messageId: string]
}>()

const bridge = useIdeBridge()
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
  // Strip metadata from the user bubble:
  //   - `[pi-attachment:att_xxx]` markers — ide-internal, server resolved already
  //   - `<file name=...>hints</file>` markup from worker augmentation
  // User just sees their typed words; the actual image renders via ImageGrid.
  const stripped = (props.message.content ?? '')
    .replace(/\s*\[pi-attachment:att_[a-z2-7]{13}\]\s*/g, ' ')
    .replace(/\s*<file name="[^"]*">[^<]*<\/file>\s*/g, '\n')
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

const thinkingExpanded = ref(false)
const toolResultExpanded = ref(new Set<string>())
// Per-arg collapse state, keyed by `${tcId}.${argKey}`.
// Each toolCall arg may itself be a multi-line string (e.g. grep/cat output);
// treat as collapsible block with the same streaming vs done semantics as
// thinking + toolResult. Click to toggle; click-while-streaming is a no-op.
const argsExpanded = ref(new Set<string>())

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

function isToolResultExpanded(tcId: string): boolean {
  return isStreaming.value || toolResultExpanded.value.has(tcId)
}

function toggleThinking() {
  if (isStreaming.value) return
  thinkingExpanded.value = !thinkingExpanded.value
}

function toggleToolResult(tcId: string) {
  if (isStreaming.value) return
  const next = new Set(toolResultExpanded.value)
  if (next.has(tcId)) next.delete(tcId)
  else next.add(tcId)
  // Set reassignment (Vue 3 ref+Set needs explicit re-set for reactivity).
  toolResultExpanded.value = next
}

function isArgExpanded(tcId: string, argKey: string): boolean {
  return isStreaming.value || argsExpanded.value.has(`${tcId}.${argKey}`)
}

function toggleArg(tcId: string, argKey: string) {
  if (isStreaming.value) return
  const k = `${tcId}.${argKey}`
  const next = new Set(argsExpanded.value)
  if (next.has(k)) next.delete(k)
  else next.add(k)
  argsExpanded.value = next
}

/** Return the first non-empty line of a multi-line string for collapsed preview. */
function firstNonEmptyLine(s: string): string {
  const lines = s.replace(/^\s+|\s+$/g, '').split('\n')
  for (const line of lines) {
    if (line.trim().length > 0) return line
  }
  return ''
}

/**
 * Flatten newlines into a literal `\n` (2 chars) so multi-line tool output
 * still fits on one preview row alongside ellipsis. The expanded block
 * renders the original text via MarkdownView, preserving real newlines.
 */
function flattenForPreview(s: string): string {
  return s.replace(/\r?\n/g, '\\n')
}

/**
 * Drag-vs-click detection for tool-result toggle. Using `@mousedown` +
 * `@mouseup` with a 4px distance threshold instead of `@click` so that a
 * text-selection drag (start in block, end anywhere in block, with movement)
 * does NOT collapse the row.
 */
const dragOrigins = new Map<string, { x: number; y: number }>()
const DRAG_THRESHOLD = 4

function onResultMouseDown(tcId: string, e: MouseEvent) {
  dragOrigins.set(tcId, { x: e.clientX, y: e.clientY })
}

function onResultMouseUp(tcId: string, e: MouseEvent) {
  const orig = dragOrigins.get(tcId)
  dragOrigins.delete(tcId)
  if (!orig || isStreaming.value) return
  const dx = e.clientX - orig.x
  const dy = e.clientY - orig.y
  if (Math.hypot(dx, dy) < DRAG_THRESHOLD) {
    toggleToolResult(tcId)
  }
}

async function openFile(path: string) {
  try {
    await bridge.invoke<void>(Methods.OPEN_FILE, { path })
  } catch (err) {
    console.warn('[MessageItem] openFile failed:', err)
  }
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

/** Stringify arg value uniformly. Strings pass through (preserve newlines for collapse preview);
 *  objects/arrays/numbers/booleans become single-line JSON (no newlines → renders inline). */
function formatArgValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** Single-line strings this long or longer collapse into the preview row
 *  even without newlines (long read payloads, full-file bash output, JSON
 *  blobs in a single arg). Same expand-to-full behavior as the multi-line
 *  branch — just a length threshold instead of a newline check. */
  const ARG_LONG_THRESHOLD = 200

  function isMultiLine(s: string): boolean {
    return /\r?\n/.test(s)
  }

  function isLong(s: string): boolean {
    return s.length > ARG_LONG_THRESHOLD
  }

  function formatArgs(args: Record<string, unknown>): { key: string; value: string; isFile: boolean; isMultiLine: boolean; isLong: boolean }[] {
    return Object.entries(args).map(([key, value]) => {
      const str = formatArgValue(value)
      return {
        key,
        value: str,
        // File-link affordance only for single-line path strings. A multi-line
        // string named `path` is almost certainly content, not a filesystem
        // path — avoid turning it into a clickable link.
        isFile: key === 'path' && typeof value === 'string' && !isMultiLine(str),
        isMultiLine: isMultiLine(str),
        isLong: !isMultiLine(str) && isLong(str),
      }
    })
  }

function toolStatus(tc: { result?: string; isError?: boolean }): { label: string; cls: string } {
  if (tc.isError) return { label: '[failed]', cls: 'status-error' }
  if (tc.result === undefined) return { label: '[running]', cls: 'status-running' }
  return { label: '[completed]', cls: 'status-completed' }
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
    <MarkdownView :source="message.content || ''" class="message-content" />

    <!-- Tool calls：call + result 合并为一个卡片 -->
    <div v-if="message.toolCalls && message.toolCalls.length > 0" class="message-toolcalls">
      <div
        v-for="tc in message.toolCalls"
        :key="tc.id"
        class="tool-card"
        :class="toolStatus(tc).cls"
      >
        <div class="tool-line1">
          <span class="tool-icon">🛠</span>
          <span class="tool-name">{{ tc.name }}</span>
          <span class="tool-call-id">({{ tc.id.slice(0, 8) }})</span>
          <span class="tool-status" :class="toolStatus(tc).cls">{{ toolStatus(tc).label }}</span>
        </div>

        <!-- Args -->
        <div class="tool-args">
          <div
            v-for="arg in formatArgs(tc.args)"
            :key="arg.key"
            class="tool-arg-row"
          >
            <span class="arg-key">{{ arg.key }}:</span>
            <!-- Single-line, short: render as-is (file path becomes a clickable link). -->
            <a
              v-if="arg.isFile"
              class="arg-value-link"
              href="#"
              @click.prevent="openFile(arg.value)"
            >{{ arg.value }}</a>
            <span v-else-if="!arg.isMultiLine && !arg.isLong" class="arg-value">{{ arg.value }}</span>
            <!-- Multi-line OR long single-line: collapsed single-line preview or
                 expanded pre block. Long strings get the same flatten + ellipsis
                 treatment as multi-line (no \n to replace, but CSS ellipsis
                 truncates). While streaming, force expanded. -->
            <template v-else>
              <span
                v-if="!isArgExpanded(tc.id, arg.key)"
                class="arg-value-preview"
                @click="toggleArg(tc.id, arg.key)"
              >
                <span class="tool-result-toggle">▶</span>{{ flattenForPreview(arg.value) }}
              </span>
              <pre
                v-else
                class="arg-value-expanded"
                @click="toggleArg(tc.id, arg.key)"
              >{{ arg.value }}</pre>
            </template>
          </div>
        </div>

        <!-- Result：默认折叠成单行预览（▶ + flatten 把换行合并到一行用 \n 转义）；
             流式时强制展开。
             Click 用 mousedown+mouseup + 距离阈值判断（不用 @click），
             防止拖选选中文字时触发折叠。 -->
        <template v-if="tc.result !== undefined">
          <div
            v-if="!isToolResultExpanded(tc.id)"
            class="tool-result-preview"
            @click="toggleToolResult(tc.id)"
          >
            <span class="tool-result-toggle">▶</span>
            {{ flattenForPreview(tc.result) }}
          </div>
          <div
            v-else
            class="tool-result-block"
            @mousedown="onResultMouseDown(tc.id, $event)"
            @mouseup="onResultMouseUp(tc.id, $event)"
          >
            <MarkdownView :source="tc.result" />
          </div>
        </template>
        <!-- Image attachments carried by the toolResult message.
             For read-tool on images: server extracted base64 in history-load
             and merged into tc.images via useSSE.mergeToolResultsIntoCalls.
             Live streaming (F6) still drops these — known v1 limitation. -->
        <ImageGrid
          v-if="tc.images && tc.images.length > 0"
          :images="tc.images"
          variant="tool"
        />
      </div>
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
  background: var(--user-bubble-bg);
  color: var(--user-bubble-text);
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
  color: var(--user-bubble-text);
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
  background: var(--bg-primary);
  color: var(--text-secondary);
  cursor: pointer;
  z-index: 1;
}
.message-copy-btn:hover {
  background: var(--user-bubble-bg);
  color: var(--user-bubble-text);
  border-color: var(--user-bubble-bg);
}

.message-thinking {
  color: var(--text-secondary);
  font-style: italic;
  font-size: 13px;
}

/* Thinking row: collapsed vs expanded (per collapse-when-done). */
.thinking-area {
  margin: 2px 0;
}
.thinking-preview {
  color: var(--text-secondary);
  font-style: italic;
  font-size: 13px;
  padding: 3px 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  user-select: none;
  border-radius: 3px;
  /* Negative margin lets the hover background extend slightly past text bounds. */
  margin: 0 -6px;
}
.thinking-preview:hover {
  background: var(--hover-bg);
}
/* 折叠态末尾的 hyperlink-style 提示文字：链接色 + 下划线，仅作用于
 * `...(collapsed)` 这一段，整行其他文字保持灰色无下划线不变。
 * 用 var(--link) 而不是硬编码 #93C5FD：后者在亮色白底上只有 2:1 对比度
 * 几乎不可见，跟 var(--link) (4.5:1+) 一致。 */
.thinking-collapsed-suffix {
  color: var(--link);
  text-decoration: underline;
  text-decoration-color: var(--link);
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
  background: var(--hover-bg);
}

.message-content {
  /* no extra styling — MarkdownView handles typography */
}

.message-toolcalls {
  margin-top: 4px;
}

.tool-card {
  background: var(--tool-done-bg);
  border-left: 3px solid var(--tool-done-border);
  padding: 6px 10px;
  margin: 4px 0;
  font-size: 13px;
}

.tool-card.status-running {
  background: var(--tool-running-bg);
  border-left-color: var(--tool-running-border);
  /* 跟 .tool-card.status-error 同模式：把内部块引用的 --tool-result-bg
   * 在 running scope 内重绑为同色系浅黄，否则 .tool-result-block /
   * .tool-result-preview / .arg-value-preview / .arg-value-expanded
   * 仍会拿到全局的绿色 done 调（亮色下中性灰、暗色下 `#274427` 深绿），
   * 跟外层黄背景撞色。 */
  --tool-result-bg: var(--tool-result-bg-running);
}

.tool-card.status-error {
  background: var(--tool-error-bg);
  border-left-color: var(--tool-error-border);
  /* Inner blocks (.tool-result-block / .tool-result-preview /
   * .arg-value-preview / .arg-value-expanded) all reference
   * var(--tool-result-bg), which defaults to the done-state shade (green
   * in dark theme, neutral gray in light). Re-bind it inside the error
   * scope so the inner blocks share the outer card's red palette instead
   * of staying green/gray — visually the card reads as one coherent "failed"
   * unit instead of a red shell with a green interior. */
  --tool-result-bg: var(--tool-result-bg-error);
}

.tool-line1 {
  display: flex;
  align-items: center;
  gap: 6px;
}

.tool-icon {
  font-size: 14px;
}

.tool-name {
  font-weight: 600;
}

.tool-call-id {
  color: var(--text-secondary);
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
}

.tool-status {
  margin-left: auto;
  font-size: 11px;
}

/* 状态文字用 *-text 变量（亮色下 700-900 阶，暗色下 300-500 阶），
 * 满足 WCAG AA。500 阶 hue 在浅色卡背景上只有 2~3:1 不可读。 */
.tool-status.status-completed { color: var(--tool-done-text); }
.tool-status.status-running { color: var(--tool-running-text); }
.tool-status.status-error { color: var(--tool-error-text); }

.tool-args {
  margin-top: 2px;
  padding-left: 22px;
}

.tool-arg-row {
  /* Flex with `min-width: 0` on the value child so a long single-line string
     can shrink and trigger the preview's `text-overflow: ellipsis`. Default
     `min-width: auto` on flex items prevents shrinking → ellipsis never
     fires even though the rule is set. */
  display: flex;
  align-items: baseline;
  margin: 1px 0;
  min-width: 0;
}
.tool-arg-row > .arg-value,
.tool-arg-row > .arg-value-link,
.tool-arg-row > .arg-value-preview,
.tool-arg-row > .arg-value-expanded {
  /* Belt-and-suspenders with the row's flex: any shrinkable child needs
  `min-width: 0` for `overflow: hidden` + `text-overflow: ellipsis` to
  actually clip. */
  min-width: 0;
  flex: 1 1 0;
}

.arg-key {
  color: var(--text-secondary);
  font-size: 12px;
  margin-right: 4px;
}

.arg-value {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.arg-value-link {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  color: var(--link);
  text-decoration: none;
  cursor: pointer;
}

.arg-value-link:hover {
  text-decoration: underline;
}

/* Multi-line arg value: collapsed preview row + expanded pre. Mirrors the
   tool-result collapse pattern so multi-line args (e.g. grep/cat content)
   don't blow up the card height when there are many of them. */
.arg-value-preview {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  user-select: none;
  background: var(--tool-result-bg);
  padding: 2px 6px;
  border-radius: 3px;
  /* inline-block + flex-basis:0 + min-width:0 lets the parent (.tool-arg-row)
  determine the actual width, triggering ellipsis on overflow. The previous
  `display: inline-block; max-width: 100%` set the inside-of-block context
  to the row, but the row itself was `display: block` with auto width → row
  shrunk-to-fit its content → ellipsis never fired. */
  display: inline-block;
  max-width: 100%;
}
.arg-value-preview:hover {
  box-shadow: inset 0 0 0 1px var(--border);
}

.arg-value-expanded {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  color: var(--text-primary);
  white-space: pre-wrap;
  word-break: break-all;
  margin: 2px 0 0;
  padding: 6px 8px;
  background: var(--tool-result-bg);
  border-radius: 4px;
  max-height: 300px;
  overflow-y: auto;
  cursor: pointer;
}

.tool-result-block {
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--tool-result-bg);
  border-radius: 4px;
  max-height: 300px;
  overflow-y: auto;
  cursor: pointer;
}

/* Collapsed result preview: single-line ellipsis in the same color block
   as the expanded state so the visual footprint is comparable. */
.tool-result-preview {
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--tool-result-bg);
  border-radius: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  color: var(--text-secondary);
  user-select: none;
}
.tool-result-preview:hover {
  /* Tint via filter would be cleanest; box-shadow outline is simpler. */
  box-shadow: inset 0 0 0 1px var(--border);
}
.tool-result-toggle {
  display: inline-block;
  margin-right: 6px;
  font-size: 10px;
  color: var(--text-secondary);
}

.message-error {
  clear: both;
  padding: 4px 0;
  display: flex;
  justify-content: flex-start;
}
</style>