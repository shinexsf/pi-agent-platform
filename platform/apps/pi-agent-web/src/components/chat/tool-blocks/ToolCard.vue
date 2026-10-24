<!--
  ToolCard — shared chrome for every tool card.

  Dispatch is **by tool name** (see `registry.ts`): `read` → ReadCard, `edit` →
  EditCard, `bash` → BashCard, … — there is no semantic "kind" category, because
  only first-party tools have a knowable category; a third-party tool (and a
  future user script) is matched by its name alone.

  This component owns only the behaviour every card shares:
    - header: icon + tool name + one-line summary + duration + status pill
    - expand/collapse: failed calls start expanded, streaming forces expanded,
      the run settling folds back unless the user pinned it by hand
    - drag-vs-click guard so selecting text inside the card doesn't collapse it
    - images attached by the tool (`view_image` etc.) render under the body

  Cards provide three slots: `summary` (header detail), `preview` (collapsed
  one-liner), `body` (expanded content), optional `foot`.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ImageGrid from '../ImageGrid.vue'
import type { ToolCall } from './types'
import { toolIcon, toolStatus } from './format'

const props = defineProps<{
  call: ToolCall
  streaming: boolean
  /** Display name — the raw tool name unless a card overrides it. */
  label?: string
}>()

const status = computed(() => toolStatus(props.call))
const icon = computed(() => toolIcon(props.call.name))

/** Wall-clock duration, shown only when the worker reported it. */
const durationLabel = computed(() => {
  const ms = props.call.durationMs
  if (typeof ms !== 'number' || ms <= 0) return null
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
})

const expanded = ref(Boolean(props.call.isError))
const pinned = ref(false)

watch(
  () => props.call.isError,
  (isErr) => {
    if (isErr && !pinned.value) expanded.value = true
  },
)

watch(
  () => props.streaming,
  (now, before) => {
    if (!(before && !now)) return
    if (!pinned.value && !props.call.isError) expanded.value = false
  },
)

function toggle() {
  if (props.streaming) return
  pinned.value = true
  expanded.value = !expanded.value
}

const dragOrigin = ref<{ x: number; y: number } | null>(null)
const DRAG_THRESHOLD = 4

function onHeadMouseDown(e: MouseEvent) {
  dragOrigin.value = { x: e.clientX, y: e.clientY }
}

function onHeadMouseUp(e: MouseEvent) {
  const origin = dragOrigin.value
  dragOrigin.value = null
  if (!origin || props.streaming) return
  if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < DRAG_THRESHOLD) {
    toggle()
  }
}

const pillState = computed(() => {
  if (status.value.cls === 'status-error') return 'bad'
  if (status.value.cls === 'status-running') return 'run'
  return 'ok'
})
</script>

<template>
  <div class="tool-card" :class="status.cls">
    <div
      class="tc-head"
      role="button"
      tabindex="0"
      :title="streaming ? '流式进行中，结束后可展开' : '点击展开/收起'"
      @mousedown="onHeadMouseDown"
      @mouseup="onHeadMouseUp"
      @keydown.enter="toggle"
    >
      <span class="tc-icon" v-html="icon" />
      <span class="tc-name">{{ label ?? call.name }}</span>
      <span class="tc-summary"><slot name="summary" /></span>
      <span v-if="durationLabel" class="tc-dur">{{ durationLabel }}</span>
      <span class="tc-pill" :class="pillState">{{ status.label }}</span>
    </div>

    <div v-if="expanded" class="tc-body">
      <slot name="body" />
    </div>
    <div v-else class="tc-preview">
      <slot name="preview" />
    </div>

    <ImageGrid v-if="call.images?.length" :images="call.images" variant="tool" />

    <div v-if="$slots.foot" class="tc-foot">
      <slot name="foot" />
    </div>
  </div>
</template>

<style scoped>
.tool-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface);
  overflow: hidden;
  margin: 8px 0;
}

.tc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 12.5px;
  color: var(--text-secondary);
  background: var(--surface-hover);
  cursor: pointer;
  user-select: none;
}

.tc-icon {
  display: inline-flex;
  color: var(--text-tertiary);
  flex: 0 0 auto;
}

.tc-name {
  color: var(--text);
  font-weight: 550;
  font-family: var(--font-mono);
  font-size: 12px;
  flex: 0 0 auto;
}

.tc-summary {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
}

.tc-dur {
  flex: 0 0 auto;
  font-size: 11.5px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.tc-pill {
  flex: 0 0 auto;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 20px;
  border: 1px solid var(--border-strong);
  color: var(--text-tertiary);
}

.tc-pill.ok {
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 40%, transparent);
}

.tc-pill.bad {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 40%, transparent);
}

.tc-pill.run {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
}

.tc-body {
  padding: 9px 11px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-secondary);
}

.tc-preview {
  padding: 6px 11px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tc-foot {
  padding: 5px 10px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-tertiary);
  display: flex;
  gap: 10px;
  align-items: center;
}

.tool-card.status-error {
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
}
</style>
