<script setup lang="ts">
/**
 * Slash command menu (per C3 / D2).
 *
 * - Popup rendered via <Teleport to="body"> (avoid overflow:hidden clipping)
 * - position: fixed via computed (first render already positioned — no scrollbar flash)
 * - selectedIndex controlled by parent InputBox; this menu receives it as prop
 * - Listens to window event '__ide_pick_slash' (dispatched by InputBox on Enter/Tab)
 * - 4 source types: builtin (◆) / extension (⌘) / prompt (⊕) / skill (⚡)
 */
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from 'vue'
import type { SlashCommand } from '../../composables/useSSE'
import { useSSE } from '../../composables/useSSE'

const props = defineProps<{
  sessionId: string
  filter: string
  selectedIndex: number
  anchorEl: HTMLElement | null
}>()

const emit = defineEmits<{
  select: [cmd: SlashCommand]
  close: []
  indexChange: [index: number]
}>()

// Subscribe to context.commands so the menu reflects the latest 4-class list.
const sse = useSSE({ sessionId: props.sessionId })
const commands = ref<SlashCommand[]>([])
let unsubscribe: (() => void) | null = null

onMounted(() => {
  unsubscribe = sse.registerContextHandler('commands', (cmds) => { commands.value = cmds })
})

onUnmounted(() => {
  unsubscribe?.()
  unsubscribe = null
})

// selectedIndex is the single source of truth from parent.
// On mouseenter, emit indexChange so parent updates; no local copy needed.

const BUILTIN_COMMAND_META: Record<string, { description?: string; argumentHint?: string }> = {
  model: { description: 'Select model', argumentHint: '<provider/model>' },
  thinking: { description: 'Set thinking level', argumentHint: '<level>' },
  name: { description: 'Set session display name', argumentHint: '<name>' },
  session: { description: 'Show session info and stats' },
  compact: { description: 'Manually compact the session context' },
  hotkeys: { description: 'Show all keyboard shortcuts' },
}

const allKnown = computed<SlashCommand[]>(() => {
  const cached = commands.value ?? []
  const names = new Set(cached.map((c) => c.name))
  const builtins: SlashCommand[] = Object.entries(BUILTIN_COMMAND_META).map(([name, meta]) => ({
    name,
    description: meta.description ?? '',
    argumentHint: meta.argumentHint,
    source: 'builtin' as const,
  }))
  return [...cached, ...builtins.filter((b) => !names.has(b.name))]
})

const filtered = computed<SlashCommand[]>(() => {
  const f = props.filter.toLowerCase()
  if (!f) return allKnown.value
  return allKnown.value.filter(
    (c) => c.name.toLowerCase().startsWith(f) || c.name.toLowerCase().includes(f)
  )
})

const clampedIndex = computed(() => Math.min(props.selectedIndex, Math.max(0, filtered.value.length - 1)))

// Container ref — used to scroll the selected item into view when keyboard nav
// moves selection outside the visible area (max-height: 240px).
const menuRef = ref<HTMLElement | null>(null)
watch(clampedIndex, (idx) => {
  // nextTick ensures the newly-rendered .slash-selected class is applied before we measure.
  nextTick(() => {
    const el = menuRef.value?.children[idx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  })
})

/** Computed style — applied on FIRST render so menu is always `position: fixed`. */
const menuStyle = computed<Record<string, string>>(() => {
  if (!props.anchorEl) {
    return {
      position: 'fixed', top: '0', left: '0', width: '0', height: '0',
      transform: 'translateY(-100%)', display: 'none',
    } as Record<string, string>
  }
  const r = props.anchorEl.getBoundingClientRect()
  return {
    position: 'fixed',
    left: `${r.left}px`,
    width: `${r.width}px`,
    top: `${r.top}px`,
    transform: 'translateY(-100%)',
    zIndex: '10000',
  }
})

function pick(idx: number) {
  const c = filtered.value[idx]
  if (c) emit('select', c)
}

function onPickEvent(e: Event) {
  pick(clampedIndex.value)
}

function sourceBadge(src: string): string {
  switch (src) {
    case 'builtin': return '◆'
    case 'extension': return '⌘'
    case 'prompt': return '⊕'
    case 'skill': return '⚡'
    default: return '·'
  }
}

onMounted(() => {
  window.addEventListener('__ide_pick_slash', onPickEvent)
})
onUnmounted(() => {
  window.removeEventListener('__ide_pick_slash', onPickEvent)
})
</script>

<template>
  <div ref="menuRef" class="slash-menu" :style="menuStyle" @click.stop>
    <div v-if="filtered.length === 0" class="slash-empty">No commands matching "/{{ filter }}"</div>
    <div
      v-for="(cmd, i) in filtered"
      :key="cmd.source + ':' + cmd.name"
      class="slash-item"
      :class="{ 'slash-selected': i === clampedIndex }"
      @click="pick(i)"
      @mouseenter="emit('indexChange', i)"
    >
      <span class="slash-source" :class="'source-' + cmd.source">{{ sourceBadge(cmd.source) }}</span>
      <span class="slash-name">/{{ cmd.name }}</span>
      <span v-if="cmd.argumentHint" class="slash-hint">{{ cmd.argumentHint }}</span>
      <span class="slash-desc">{{ cmd.description }}</span>
    </div>
  </div>
</template>

<style scoped>
.slash-menu {
  max-height: 240px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow-raised);
  padding: 4px 0;
}

.slash-empty {
  padding: 12px 16px;
  color: var(--text-secondary);
  font-size: 12px;
}

.slash-item {
  display: grid;
  grid-template-columns: 24px auto auto 1fr;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
  align-items: baseline;
}

.slash-item.slash-selected {
  background: var(--accent);
  color: white;
}
.slash-item.slash-selected .slash-desc,
.slash-item.slash-selected .slash-hint {
  color: white;
  opacity: 0.85;
}

.slash-source {
  font-size: 14px;
  text-align: center;
  color: var(--text-secondary);
}
.slash-name {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
}
.slash-hint {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-secondary);
}
.slash-desc {
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>