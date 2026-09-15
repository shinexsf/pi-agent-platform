<script setup lang="ts">
/**
 * Thinking level selector (per C5 / D13).
 *
 * Per user feedback:
 *   - No "thinking" / 🧠 label
 *   - Show current level only
 *   - Empty state: subtle placeholder
 *   - Right-aligned chevron-up SVG icon
 *   - Not bold
 *   - Popup rendered via <Teleport to="body"> so it's not clipped by the
 *     input-wrapper's overflow:hidden.
 */
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { useSSE } from '../../composables/useSSE'
import type { ModelInfo } from '@pi-agent-platform/api-types'

const props = defineProps<{
  sessionId: string
}>()

const emit = defineEmits<{
  select: [level: string]
}>()

// All possible thinking levels from pi SDK
const ALL_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

// Subscribe to context (currentThinkingLevel, currentModel, models)
const sse = useSSE({ sessionId: props.sessionId })
const current = ref<string | null>(null)
const currentModel = ref<{ provider: string; modelId: string } | null>(null)
const models = ref<ModelInfo[]>([])
let unsubscribeCurrent: (() => void) | null = null
let unsubscribeModel: (() => void) | null = null
let unsubscribeModels: (() => void) | null = null

onMounted(() => {
  unsubscribeCurrent = sse.registerContextHandler('currentThinkingLevel', (l) => {
    current.value = l ?? null
  })
  unsubscribeModel = sse.registerContextHandler('currentModel', (m) => {
    currentModel.value = m ?? null
  })
  unsubscribeModels = sse.registerContextHandler('models', (m) => {
    models.value = m ?? []
  })
})

onUnmounted(() => {
  unsubscribeCurrent?.()
  unsubscribeModel?.()
  unsubscribeModels?.()
})

// Compute available levels for current model
const availableLevels = computed(() => {
  if (!currentModel.value) {
    // No model selected, show defaults
    return ['off', 'low', 'medium', 'high']
  }
  
  // Find current model in models list
  const model = models.value.find(
    m => m.provider === currentModel.value!.provider && m.modelId === currentModel.value!.modelId
  )
  
  if (!model?.thinkingLevelMap) {
    // No thinkingLevelMap, show defaults
    return ['off', 'low', 'medium', 'high']
  }
  
  // Filter levels based on thinkingLevelMap (null = unsupported)
  return ALL_LEVELS.filter(l => model.thinkingLevelMap![l] !== null)
})

const open = ref(false)
const triggerEl = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const panelStyle = ref<Record<string, string>>({})

function repositionPanel() {
  if (!triggerEl.value) return
  const rect = triggerEl.value.getBoundingClientRect()
  panelStyle.value = {
    position: 'fixed',
    left: `${rect.left}px`,
    top: `${rect.top - 4}px`,
    transform: 'translateY(-100%)',
    zIndex: '9999',
  }
}

async function toggle() {
  open.value = !open.value
  if (open.value) {
    await nextTick()
    repositionPanel()
  }
}

function pick(l: string) {
  emit('select', l)
  open.value = false
}

function onWindowClick(e: MouseEvent) {
  if (!open.value) return
  if (
    panelEl.value && !panelEl.value.contains(e.target as Node) &&
    triggerEl.value && !triggerEl.value.contains(e.target as Node)
  ) {
    open.value = false
  }
}

function onWindowScroll() {
  if (open.value) repositionPanel()
}

watch(open, (v) => {
  if (v) {
    window.addEventListener('click', onWindowClick)
    window.addEventListener('scroll', onWindowScroll, true)
    window.addEventListener('resize', onWindowScroll)
  } else {
    window.removeEventListener('click', onWindowClick)
    window.removeEventListener('scroll', onWindowScroll, true)
    window.removeEventListener('resize', onWindowScroll)
  }
})

onUnmounted(() => {
  window.removeEventListener('click', onWindowClick)
  window.removeEventListener('scroll', onWindowScroll, true)
  window.removeEventListener('resize', onWindowScroll)
})
</script>

<template>
  <div class="thinking-selector">
    <button
      ref="triggerEl"
      class="thinking-trigger"
      type="button"
      :class="{ 'thinking-empty': !current }"
      @click.stop="toggle"
    >
      <span class="thinking-label">{{ current ?? 'thinking' }}</span>
      <svg class="thinking-chevron" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
        <path d="M2 4 L6 8 L10 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <Teleport v-if="open" to="body">
      <div
        ref="panelEl"
        class="thinking-panel"
        :style="panelStyle"
        @click.stop
      >
        <div
          v-for="l in availableLevels"
          :key="l"
          class="thinking-item"
          :class="{ 'thinking-current': current === l }"
          @click="pick(l)"
        >
          <span class="thinking-name">{{ l }}</span>
          <span v-if="current === l" class="thinking-check">✓</span>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.thinking-selector {
  position: relative;
  flex: 0 1 auto;
  min-width: 0;
}

.thinking-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  color: var(--text);
  font-size: 12px;
  font-weight: 400;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 3px;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
}
.thinking-trigger:hover {
  background: var(--surface-hover);
}
.thinking-empty {
  color: var(--text-secondary);
  font-style: italic;
}

.thinking-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.thinking-chevron {
  flex-shrink: 0;
  opacity: 0.6;
}
.thinking-trigger:hover .thinking-chevron {
  opacity: 1;
}
</style>

<style>
/* Panel rendered via Teleport — not scoped, lives in <body>. */
.thinking-panel {
  min-width: 120px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: var(--shadow-raised);
  padding: 4px 0;
}

.thinking-item {
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.thinking-item:hover {
  background: var(--accent);
  color: white;
}
.thinking-current {
  background: var(--surface-hover);
}
.thinking-check {
  font-size: 11px;
  color: var(--success, #10b981);
}
.thinking-item:hover .thinking-check {
  color: white;
}
</style>