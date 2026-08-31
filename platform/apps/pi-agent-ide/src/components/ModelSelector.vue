<script setup lang="ts">
/**
 * Model selector (per C4 / C7).
 *
 * Per user feedback:
 *   - No "Model…" label; just show current model display name
 *   - Empty state: subtle placeholder ("model")
 *   - Right-aligned chevron-up SVG icon (clickable affordance)
 *   - Not bold by default
 *   - Popup rendered via <Teleport to="body"> so it's not clipped by the
 *     input-wrapper's overflow:hidden (D3 fix: popup overflow).
 */
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import type { ModelInfo } from '../composables/useSSE'
import { useSSE } from '../composables/useSSE'

const props = defineProps<{
  sessionId: string
}>()

const emit = defineEmits<{
  select: [provider: string, modelId: string]
}>()

// Subscribe to context: models list + currentModel field (works for both placeholder
// and active sessions — server computes from workerPool entry or session row).
const sse = useSSE({ sessionId: props.sessionId })
const models = ref<ModelInfo[]>([])
const currentModel = ref<{ provider: string; modelId: string } | null>(null)
let unsubscribe: Array<() => void> = []

onMounted(() => {
  unsubscribe.push(
    sse.registerContextHandler('models', (m) => { models.value = m }),
  )
  unsubscribe.push(
    sse.registerContextHandler('currentModel', (m) => { currentModel.value = m }),
  )
})

onUnmounted(() => {
  for (const off of unsubscribe) off()
  unsubscribe = []
})

const open = ref(false)
const triggerEl = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const panelStyle = ref<Record<string, string>>({})

const display = computed(() => {
  if (!currentModel.value) return null
  const found = models.value.find(
    (m) => m.provider === currentModel.value!.provider && m.modelId === currentModel.value!.modelId,
  )
  if (found) return found.displayName
  if (currentModel.value.provider) {
    return `${currentModel.value.provider}/${currentModel.value.modelId}`
  }
  return currentModel.value.modelId
})

function repositionPanel() {
  if (!triggerEl.value) return
  const rect = triggerEl.value.getBoundingClientRect()
  // Place above the trigger, left-aligned with it
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

function pick(m: ModelInfo) {
  emit('select', m.provider, m.modelId)
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
  <div class="model-selector">
    <button
      ref="triggerEl"
      class="model-trigger"
      type="button"
      :class="{ 'model-empty': !display }"
      @click.stop="toggle"
    >
      <span class="model-label">{{ display ?? 'model' }}</span>
      <svg class="model-chevron" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
        <path d="M2 4 L6 8 L10 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <Teleport v-if="open" to="body">
      <div
        ref="panelEl"
        class="model-panel"
        :style="panelStyle"
        @click.stop
      >
        <div v-if="models.length === 0" class="model-empty-row">Loading…</div>
        <div
          v-for="m in models"
          :key="m.provider + ':' + m.modelId"
          class="model-item"
          :class="{
            'model-current': currentModel?.provider === m.provider && currentModel?.modelId === m.modelId,
            'model-disabled': !m.hasAuth,
          }"
          @click="m.hasAuth && pick(m)"
        >
          <span class="model-name">{{ m.displayName }}</span>
          <span v-if="!m.hasAuth" class="model-noauth">no auth</span>
          <span v-if="currentModel?.provider === m.provider && currentModel?.modelId === m.modelId" class="model-check">✓</span>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.model-selector {
  position: relative;
}

.model-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 400;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 3px;
  max-width: 200px;
}
.model-trigger:hover {
  background: rgba(128, 128, 128, 0.1);
}
.model-empty {
  color: var(--text-secondary);
  font-style: italic;
}

.model-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.model-chevron {
  flex-shrink: 0;
  opacity: 0.6;
}
.model-trigger:hover .model-chevron {
  opacity: 1;
}
</style>

<style>
/* Panel rendered via Teleport — not scoped, lives in <body>. */
.model-panel {
  min-width: 220px;
  max-height: 280px;
  overflow-y: auto;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.18);
  padding: 4px 0;
}

.model-empty-row {
  padding: 12px 16px;
  color: var(--text-secondary);
  font-size: 12px;
}

.model-item {
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.model-item:hover:not(.model-disabled) {
  background: var(--user-bubble-bg);
  color: var(--user-bubble-text);
}
.model-current {
  background: rgba(128, 128, 128, 0.15);
}
.model-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.model-noauth {
  font-size: 11px;
  color: var(--tool-error-border);
}
.model-item:hover:not(.model-disabled) .model-noauth {
  color: var(--user-bubble-text);
}
.model-check {
  font-size: 11px;
  color: var(--tool-done-border);
}
.model-item:hover:not(.model-disabled) .model-check {
  color: var(--user-bubble-text);
}
</style>