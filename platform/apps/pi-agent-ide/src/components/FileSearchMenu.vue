<script setup lang="ts">
/**
 * File search menu (per C6 / D14).
 *
 * - Popup rendered via <Teleport to="body">
 * - position: fixed via computed (no scrollbar flash on mount)
 * - selectedIndex controlled by parent InputBox
 * - Listens to window event '__ide_pick_at' (Enter/Tab from InputBox)
 * - Empty state for empty query (Kotlin handleSearchFiles returns [] for "")
 */
import { ref, watch, computed, onMounted, onUnmounted } from 'vue'
import { useIdeBridge } from '../composables/useIdeBridge'

const props = defineProps<{
  filter: string
  selectedIndex: number
  anchorEl: HTMLElement | null
}>()

const emit = defineEmits<{
  select: [label: string, relativePath: string]
  close: []
}>()

const bridge = useIdeBridge()
const hits = ref<Array<{ path: string; label: string; relativePath: string }>>([])
const loading = ref(false)
const localIndex = ref(0)

watch(() => props.selectedIndex, (v) => { localIndex.value = v })

/** Computed style — first render already positioned. */
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

const clampedIndex = computed(() => Math.min(localIndex.value, Math.max(0, hits.value.length - 1)))

watch(() => props.filter, async (q) => {
  loading.value = true
  try {
    // bridge.invoke resolves with `result.data` directly (NOT a {ok,data} envelope).
    const data = await bridge.invoke<Array<{ path: string; label: string; relativePath: string }>>(
      'context.searchFiles',
      { query: q, limit: 20 },
    )
    console.log('[FileSearch] result:', data)
    hits.value = Array.isArray(data) ? data : []
  } catch (e) {
    hits.value = []
    console.warn('[FileSearch] failed:', e)
  } finally {
    loading.value = false
  }
}, { immediate: true })

function pick(idx: number) {
  const h = hits.value[idx]
  if (h) emit('select', h.label, h.relativePath)
}

function onPickEvent(e: Event) {
  pick(clampedIndex.value)
}

onMounted(() => {
  window.addEventListener('__ide_pick_at', onPickEvent)
})
onUnmounted(() => {
  window.removeEventListener('__ide_pick_at', onPickEvent)
})
</script>

<template>
  <div class="file-menu" :style="menuStyle" @click.stop>
    <div v-if="loading" class="file-loading">Searching "{{ filter }}"…</div>
    <div v-else-if="hits.length === 0" class="file-empty">No files matching "@{{ filter }}"</div>
    <div
      v-for="(hit, i) in hits"
      :key="hit.path"
      class="file-item"
      :class="{ 'file-selected': i === clampedIndex }"
      @click="pick(i)"
      @mouseenter="localIndex = i"
    >
      <span class="file-icon">📄</span>
      <span class="file-label">{{ hit.label }}</span>
      <span class="file-relpath">{{ hit.relativePath }}</span>
    </div>
  </div>
</template>

<style scoped>
.file-menu {
  max-height: 240px;
  overflow-y: auto;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow-popup);
  padding: 4px 0;
}

.file-loading,
.file-empty {
  padding: 12px 16px;
  color: var(--text-secondary);
  font-size: 12px;
}

.file-item {
  display: grid;
  grid-template-columns: 24px auto 1fr;
  gap: 8px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
  align-items: baseline;
}
.file-item.file-selected {
  background: var(--user-bubble-bg);
  color: var(--user-bubble-text);
}
.file-item.file-selected .file-relpath {
  color: var(--user-bubble-text);
  opacity: 0.85;
}
.file-item:hover:not(.file-selected) {
  background: var(--hover-bg);
}

.file-icon {
  font-size: 13px;
}
.file-label {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 600;
}
.file-relpath {
  color: var(--text-secondary);
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>