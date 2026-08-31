<script setup lang="ts">
/**
 * Chat input box (per D8 + C1/C2/C3/C4/C5/C6).
 *
 * Layout (per user feedback):
 *   - Outer wrapper with #26282C rounded border (light box around input + toolbar)
 *   - Pill row on top (image attachments with × button — clicking × removes
 *     both the pill AND the corresponding marker from the textarea text)
 *   - Textarea on top of pill row
 *   - Toolbar on bottom with: + (attach), Steer indicator (always-on), Model selector, Thinking selector
 *   - Top edge of wrapper is draggable to resize height (CSS resize: vertical)
 *   - No "follow-up" mode — only steer (per user feedback)
 *
 * Image attachments:
 *   - paste on textarea -> upload via `attachmentsUploader.uploadImage` -> cache by id
 *   - drag & drop -> same path
 *   - "+" button opens hidden file input -> same path
 *   - pill above carries × that strips the marker from textarea text
 *   - on send(): emit text (with markers) + cache snapshot
 */

import { ref, onMounted, onUnmounted, nextTick, computed } from 'vue'
import type { SlashCommand, ModelInfo } from '../composables/useSSE'
import { useSSE } from '../composables/useSSE'
import { useIdeBridge } from '../composables/useIdeBridge'
import type { UploadedAttachment } from '../composables/useAttachments'
import SlashCommandMenu from './SlashCommandMenu.vue'
import ModelSelector from './ModelSelector.vue'
import ThinkingSelector from './ThinkingSelector.vue'
import FileSearchMenu from './FileSearchMenu.vue'
import ContextUsage from './ContextUsage.vue'
import ImagePill from './ImagePill.vue'

/**
 * Builtin slash commands — hard-coded fallback so Enter on `/session` / `/hotkeys`
 * etc. executes even when the commands cache hasn't loaded yet (fetch in flight or
 * failed). Must stay in sync with the server's PLACEHOLDER_BUILTIN_COMMANDS.
 */
const BUILTIN_COMMAND_META: Record<string, { description?: string; argumentHint?: string }> = {
  model: { description: 'Select model', argumentHint: '<provider/model>' },
  thinking: { description: 'Set thinking level', argumentHint: '<level>' },
  name: { description: 'Set session display name', argumentHint: '<name>' },
  session: { description: 'Show session info and stats' },
  compact: { description: 'Manually compact the session context' },
  hotkeys: { description: 'Show all keyboard shortcuts' },
}

const props = defineProps<{
  sessionId: string
  agentId: string
  disabled?: boolean
  sending: boolean
  /** Per-tab attachment handler injected by App.vue (Option A — cache 直传). */
  attachmentsUploader: {
    uploadImage: (file: File) => Promise<UploadedAttachment | null>
    forget: (id: string) => void
    clear: () => void
    listForSend: () => UploadedAttachment[]
  }
}>()

const emit = defineEmits<{
  send: [message: string, attachedImages: Array<{ mimeType: string; data: string }>]
  abort: []
  dispatchCommand: [name: string, args: string]
  setModel: [provider: string, modelId: string]
  setThinkingLevel: [level: 'off' | 'low' | 'medium' | 'high']
}>()

// Subscribed via useSSE().registerContextHandler (commands + models + session fields).
// SlashCommandMenu / ModelSelector / ThinkingSelector also subscribe themselves and
// don't need props from this component anymore.
const sse = useSSE({ sessionId: props.sessionId })
const commands = computed<SlashCommand[]>(() => sse.contextCache.value?.commands ?? [])

// ── Resize handle (drag top edge to change height) ──
const MIN_H = 96
const MAX_H = 360
const wrapperHeight = ref<number | null>(null)
let dragStartY = 0
let dragStartH = 0
let dragging = false

function onResizeMouseDown(e: MouseEvent) {
  if (!wrapperEl.value) return
  dragging = true
  dragStartY = e.clientY
  dragStartH = wrapperEl.value.getBoundingClientRect().height
  document.addEventListener('mousemove', onResizeMouseMove)
  document.addEventListener('mouseup', onResizeMouseUp)
  e.preventDefault()
}
function onResizeMouseMove(e: MouseEvent) {
  if (!dragging) return
  const newH = Math.min(MAX_H, Math.max(MIN_H, dragStartH + (dragStartY - e.clientY)))
  wrapperHeight.value = newH
}
function onResizeMouseUp() {
  dragging = false
  document.removeEventListener('mousemove', onResizeMouseMove)
  document.removeEventListener('mouseup', onResizeMouseUp)
}
onUnmounted(() => {
  document.removeEventListener('mousemove', onResizeMouseMove)
  document.removeEventListener('mouseup', onResizeMouseUp)
})

// ── Trigger overlays state ──
const slashOpen = ref(false)
const slashFilter = ref('')
const slashStart = ref(0)
const slashIndex = ref(0)
const atOpen = ref(false)
const atFilter = ref('')
const atStart = ref(0)
const atIndex = ref(0)

function onInput(e: Event) {
  const ta = e.target as HTMLTextAreaElement
  // Sync v-model manually (we use :value + @input instead of v-model
  // to guarantee onInput runs even when v-model is the only binding).
  input.value = ta.value
  const value = ta.value
  const caret = ta.selectionStart ?? value.length

  // Slash command trigger: ONLY at line start (position 0 of input, or right
  // after a newline). Mirrors old plugin's `RawEditorInputArea.kt:188-190`
  // `(slashIdx == 0 || before[slashIdx - 1] == '\n')`. The previous `^|\s`
  // also fired on mid-line spaces, which caused false pops when users typed
  // things like `see /tmp/foo` or wrote a URL.
  const slashMatch = /(?:^|\n)\/([\w-]*)$/.exec(value.slice(0, caret))
  if (slashMatch && slashMatch[1] !== undefined) {
    slashOpen.value = true
    slashFilter.value = slashMatch[1]
    slashStart.value = caret - slashMatch[1].length - 1
    atOpen.value = false
    return
  }
  // @ trigger: any @ followed by non-@/non-space up to caret
  const atMatch = /@([^@\s]*)$/.exec(value.slice(0, caret))
  if (atMatch && atMatch[1] !== undefined) {
    atOpen.value = true
    atFilter.value = atMatch[1]
    atStart.value = caret - atMatch[1].length - 1
    slashOpen.value = false
    return
  }
  slashOpen.value = false
  atOpen.value = false
}

function applySlashCommand(cmd: SlashCommand, mode: 'complete' | 'execute' = 'execute') {
  slashOpen.value = false
  const complete = () => {
    const before = input.value.slice(0, slashStart.value)
    const after = input.value.slice(slashStart.value + 1 + slashFilter.value.length)
    input.value = before + `/${cmd.name} ` + after
    nextTick(() => textareaEl.value?.focus())
  }
  // Tab: always just complete into the box (user then types args, presses Enter).
  if (mode === 'complete') {
    complete()
    return
  }
  // Enter / click: no-arg commands execute immediately; arg commands complete.
  if (!cmd.argumentHint) {
    input.value = ''
    emit('dispatchCommand', cmd.name, '')
    nextTick(() => textareaEl.value?.focus())
    return
  }
  complete()
}

function applyFilePath(label: string, relativePath: string) {
  const before = input.value.slice(0, atStart.value)
  const after = input.value.slice(atStart.value + 1 + atFilter.value.length)
  const insertion = `@${relativePath} `
  input.value = before + insertion + after
  atOpen.value = false
  nextTick(() => textareaEl.value?.focus())
}

function send() {
  const text = input.value.trim()
  if (!text) return

  // Slash-command fast-path: if the input is an exact known command (/name or
  // /name args), execute it instead of sending it to the model. This fixes the
  // "Tab-complete then Enter sends /session as a user prompt" bug — after Tab
  // the menu is closed (slashOpen=false) so the old code fell through to send().
  const m = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text)
  if (m && m[1]) {
    const name = m[1]
    const args = m[2] ?? ''
    // Prefer the live cache; fall back to hard-coded builtins so `/session` works
    // even before commandsCache has loaded (or if its fetch failed).
    const cmd = (commands.value ?? []).find((c) => c.name === name)
    const meta = cmd ?? BUILTIN_COMMAND_META[name]
    if (meta) {
      if (!meta.argumentHint || args) {
        // No-arg command, or args already typed → execute immediately
        input.value = ''
        emit('dispatchCommand', name, args)
        nextTick(() => textareaEl.value?.focus())
        return
      }
      // Has argumentHint but no args typed → keep text in box so the user can
      // type args (do NOT send it to the model as a user prompt)
      textareaEl.value?.focus()
      return
    }
  }

  // Option A — collect a snapshot of cached attachments and emit them along
  // with the message text (see design.md "F3 实现选型"). After emit, both the
  // pill row AND the upstream useAttachments.cache are cleared.
  const attached = props.attachmentsUploader.listForSend()
  const attachedImages = attached.map((a) => ({ mimeType: a.mimeType, data: a.dataB64 }))
  emit('send', text, attachedImages)

  // Clear pill render state + textarea content + upstream cache. Wrapping the
  // Map reassignment in a fresh Map() forces Vue ref reactivity (Vue 3 doesn't
  // track Map mutation in-place; reassigning the ref is the supported pattern).
  attachments.value = new Map()
  props.attachmentsUploader.clear()
  input.value = ''
}

function abortSend() {
  emit('abort')
}

function onKeyDown(e: KeyboardEvent) {
  // ── Menu open: navigation keys first ──
  if (slashOpen.value) {
    if (e.key === 'ArrowDown') {
      slashIndex.value = slashIndex.value + 1
      e.preventDefault(); e.stopPropagation(); return
    }
    if (e.key === 'ArrowUp') {
      slashIndex.value = Math.max(0, slashIndex.value - 1)
      e.preventDefault(); e.stopPropagation(); return
    }
    if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation()
      const cmds = filteredSlashCommands()
      const cmd = cmds[slashIndex.value]
      if (cmd) applySlashCommand(cmd, 'execute')
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation()
      const cmds = filteredSlashCommands()
      const cmd = cmds[slashIndex.value]
      if (cmd) applySlashCommand(cmd, 'complete')
      return
    }
    if (e.key === 'Escape') {
      slashOpen.value = false
      e.preventDefault(); e.stopPropagation(); return
    }
  }
  if (atOpen.value) {
    if (e.key === 'ArrowDown') {
      atIndex.value = atIndex.value + 1
      e.preventDefault(); e.stopPropagation(); return
    }
    if (e.key === 'ArrowUp') {
      atIndex.value = Math.max(0, atIndex.value - 1)
      e.preventDefault(); e.stopPropagation(); return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault(); e.stopPropagation()
      window.dispatchEvent(new CustomEvent('__ide_pick_at', { detail: atIndex.value }))
      return
    }
    if (e.key === 'Escape') {
      atOpen.value = false
      e.preventDefault(); e.stopPropagation(); return
    }
  }

  // Image attachment shortcut: pressing Backspace when the caret is right
  // after a `[pi-attachment:att_xxx]` marker (with optional trailing whitespace)
  // deletes the WHOLE marker text in one keystroke. The matching pill above
  // the textarea disappears too because we remove the cache + pill Map rows
  // for the same id. This is a UX shortcut to "press Delete once to remove
  // an image attachment" without committing the user to finding both the
  // marker text inside the input AND the × on the pill row.
  if (e.key === 'Backspace') {
    const ta = textareaEl.value
    if (ta) {
      const cursor = ta.selectionStart ?? 0
      const end = ta.selectionEnd ?? 0
      if (cursor === end) {
        const before = ta.value.slice(0, cursor)
        // Match marker followed by optional trailing whitespace.
        const m = before.match(/\[pi-attachment:(att_[a-z2-7]{13})\]\s*$/)
        if (m && m[1] && m[0]) {
          e.preventDefault()
          e.stopPropagation()
          const id = m[1]
          const spanLen = m[0].length
          const newText = ta.value.slice(0, cursor - spanLen) + ta.value.slice(cursor)
          input.value = newText
          // Drop pill + upstream cache.
          attachments.value.delete(id)
          attachments.value = new Map(attachments.value)
          props.attachmentsUploader.forget(id)
          nextTick(() => {
            const next = cursor - spanLen
            ta.setSelectionRange(next, next)
          })
          return
        }
      }
    }
  }

  // Default: Enter sends
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
    return
  }
}

// ── Pill row (image attachments) ──
// Each pill on × → strips the corresponding marker from textarea text + removes
// from the upstream cache.
const attachments = ref(new Map<string, UploadedAttachment>())

function removePill(id: string) {
  attachments.value.delete(id)
  attachments.value = new Map(attachments.value)
  props.attachmentsUploader.forget(id)
  // Strip the marker from textarea text. The pattern matches the marker
  // plus its surrounding whitespace so surrounding text doesn't gap.
  const marker = `[pi-attachment:${id}]`
  // Escape regex meta chars (only `[`, `]`, `$`, `^` matter here)
  const escaped = marker.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
  input.value = input.value
    .replace(new RegExp(`\\s*${escaped}\\s*`, 'g'), ' ')
    .trimStart()
}

// Close menu on global click outside textarea / menu
function filteredSlashCommands(): SlashCommand[] {
  const f = slashFilter.value.toLowerCase()
  const all = allKnownCommands()
  if (!f) return all.slice(0, 20)
  return all.filter((c: SlashCommand) => c.name.toLowerCase().startsWith(f) || c.name.toLowerCase().includes(f)).slice(0, 20)
}

function allKnownCommands(): SlashCommand[] {
  const cached = commands.value ?? []
  const names = new Set(cached.map((c) => c.name))
  const builtins: SlashCommand[] = Object.entries(BUILTIN_COMMAND_META).map(([name, meta]) => ({
    name,
    description: meta.description ?? '',
    argumentHint: meta.argumentHint,
    source: 'builtin' as const,
  }))
  return [...cached, ...builtins.filter((b) => !names.has(b.name))]
}

function onGlobalClick(e: MouseEvent) {
  if (!slashOpen.value && !atOpen.value) return
  if (textareaEl.value && (e.target === textareaEl.value || textareaEl.value.contains(e.target as Node))) return
  slashOpen.value = false
  atOpen.value = false
}

// ── Image attachments: paste / drop / file picker ──
//
// Each path lands files through props.attachmentsUploader.uploadImage(file),
// which uploads server-side + caches a base64 row. On success we insert a
// `[pi-attachment:att_xxx]` marker into the textarea at the caret (surrounded
// by whitespace) — server's prompt route regex-extracts markers and forwards
// IDs to the worker. We do NOT inline the base64 in the textarea (would blow
// up text + lose the size cap); the pill above is the visual representation,
// the marker is the protocol handle.
const input = ref('')
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const wrapperEl = ref<HTMLElement | null>(null)

function isImageFile(file: File): boolean {
  return !!file && file.type.startsWith('image/')
}

async function ingestFiles(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    if (!isImageFile(f)) continue
    const entry = await props.attachmentsUploader.uploadImage(f)
    if (!entry) continue
    attachments.value.set(entry.id, entry)
    // Force reactivity on Map mutation.
    attachments.value = new Map(attachments.value)
    // Insert marker into textarea at caret. Always wrap with whitespace on
    // both sides so the marker never glues to user prose. If the user is at
    // the start of input (caret=0) we omit the leading whitespace.
    const ta = textareaEl.value
    const marker = `[pi-attachment:${entry.id}]`
    if (ta) {
      const start = ta.selectionStart ?? input.value.length
      const end = ta.selectionEnd ?? start
      const leading = start > 0 && input.value[start - 1] !== ' ' ? ' ' : ''
      const trailing = input.value[start] !== ' ' ? ' ' : ''
      input.value =
        input.value.slice(0, start) + leading + marker + trailing + input.value.slice(end)
      nextTick(() => {
        const caret = start + leading.length + marker.length + trailing.length
        ta.focus()
        ta.setSelectionRange(caret, caret)
      })
    } else {
      // No DOM ref (e.g., mounted-on-client but not yet). Just append at end.
      input.value = `${input.value} ${marker}`.trimStart()
    }
  }
}

function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items || items.length === 0) return
  const files: File[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it && it.kind === 'file') {
      const f = it.getAsFile()
      if (f && isImageFile(f)) files.push(f)
    }
  }
  if (files.length > 0) {
    e.preventDefault()
    void ingestFiles(files)
    // Plain text paste still lands: browser inserts text only when no files
    // match. Trade-off: a paste with BOTH images + text drops the text.
    // Acceptable for v1.
  }
}

function onDrop(e: DragEvent) {
  if (!e.dataTransfer) return
  const files = Array.from(e.dataTransfer.files).filter(isImageFile)
  if (files.length > 0) {
    e.preventDefault()
    void ingestFiles(files)
  }
}

function onDragOver(e: DragEvent) {
  if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
}

function onPickerChange(e: Event) {
  const inputEl = e.target as HTMLInputElement
  if (!inputEl.files) return
  void ingestFiles(inputEl.files)
  inputEl.value = '' // allow re-selecting same file
}

const fileInputEl = ref<HTMLInputElement | null>(null)

onMounted(() => {
  textareaEl.value?.focus()
  window.addEventListener('click', onGlobalClick)
})
onUnmounted(() => {
  window.removeEventListener('click', onGlobalClick)
})
</script>

<template>
  <div
    ref="wrapperEl"
    class="input-wrapper"
    :style="wrapperHeight ? { height: wrapperHeight + 'px' } : undefined"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <!-- Slash command menu overlay (Teleport to body to escape overflow:hidden) -->
    <Teleport v-if="slashOpen" to="body">
      <SlashCommandMenu
        :session-id="sessionId"
        :filter="slashFilter"
        :selected-index="slashIndex"
        :anchor-el="textareaEl"
        @select="applySlashCommand"
        @close="slashOpen = false"
      />
    </Teleport>
    <!-- File search menu overlay (Teleport to body) -->
    <Teleport v-if="atOpen" to="body">
      <FileSearchMenu
        :filter="atFilter"
        :selected-index="atIndex"
        :anchor-el="textareaEl"
        @select="applyFilePath"
        @close="atOpen = false"
      />
    </Teleport>

    <!-- Attachment pills (above the textarea). Each row carries an ×. -->
    <div v-if="attachments.size > 0" class="input-pills">
      <ImagePill
        v-for="att in Array.from(attachments.values())"
        :key="att.id"
        :attachment="att"
        @remove="removePill"
      />
    </div>

    <textarea
      ref="textareaEl"
      :value="input"
      class="input-textarea"
      :disabled="disabled"
      placeholder="Message…  (Enter to send, Shift+Enter newline, paste/drop to attach)"
      rows="3"
      @input="onInput"
      @paste="onPaste"
      @keydown="onKeyDown"
    />

    <div
      class="input-resize-handle"
      aria-hidden="true"
      @mousedown="onResizeMouseDown"
    />

    <div class="input-toolbar">
      <button
        class="toolbar-icon-btn attach-btn"
        type="button"
        title="Attach image (PNG/JPEG/GIF/WebP, ≤ 25 MB)"
        :disabled="attachmentsUploader ? undefined : true"
        @click="fileInputEl?.click()"
      >+</button>
      <input
        ref="fileInputEl"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        hidden
        @change="onPickerChange"
      />

      <span class="steer-indicator" title="Steer mode (always-on; queued messages interrupt the current agent)">
        <span class="steer-dot"></span>
        Steer
      </span>

      <ModelSelector
        :session-id="sessionId"
        @select="(p: string, mid: string) => emit('setModel', p, mid)"
      />
      <ThinkingSelector
        :session-id="sessionId"
        @select="(l: 'off' | 'low' | 'medium' | 'high') => emit('setThinkingLevel', l)"
      />
      <ContextUsage :session-id="sessionId" />

      <div class="input-toolbar-spacer" />

      <button
        v-if="sending"
        class="abort-btn"
        type="button"
        @click="abortSend"
      >■</button>
      <button
        v-else
        class="send-btn"
        type="button"
        :disabled="disabled || !input.trim()"
        @click="send"
      >▶</button>
    </div>
  </div>
</template>

<style scoped>
.input-wrapper {
  position: relative;
  background: transparent;
  border: 1px solid #26282C;
  border-radius: 8px;
  overflow: hidden;
  min-height: 96px;
  max-height: 360px;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  margin: 4px 8px 4px;
  transition: border-color 0.12s;
}
.input-wrapper:hover {
  border-color: #3a3d42;
}
.input-wrapper:focus-within {
  border-color: #3577E9;
}

.input-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px 0;
  /* sit just above the textarea, scroll horizontally if many pills */
  max-width: 100%;
  overflow-x: auto;
}

.input-textarea {
  flex: 1;
  width: 100%;
  min-height: 60px; /* ~3 lines @ 20px line-height */
  padding: 8px 10px 2px;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  resize: none;
  overflow-y: auto;
  display: block;
}

.input-textarea:disabled {
  opacity: 0.5;
}

/* No inline chip styles — committed back to plain markers in textarea.
 * Use Array.from(values()) in v-for (avoid .values() iterator reactivity gap). */

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

.input-resize-handle {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 4px;
  cursor: ns-resize;
  background: transparent;
  z-index: 2;
}

.input-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px 3px;
  /* no border-top: toolbar visually merges with textarea above */
  flex-shrink: 0;
}

.toolbar-icon-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 3px;
  line-height: 1;
}
.toolbar-icon-btn:hover {
  background: rgba(128, 128, 128, 0.15);
  color: var(--text-primary);
}

.steer-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-secondary);
  padding: 2px 6px;
  user-select: none;
}
.steer-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--user-bubble-bg);
}

.input-toolbar-spacer {
  flex: 1;
}

.send-btn,
.abort-btn {
  background: transparent;
  color: var(--text-secondary);
  border: none;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 13px;
  border-radius: 4px;
}
.send-btn:hover:not(:disabled),
.abort-btn:hover {
  color: var(--user-bubble-bg);
  background: rgba(128, 128, 128, 0.1);
}
.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.abort-btn {
  color: var(--tool-error-border);
  font-weight: 500;
}
</style>
