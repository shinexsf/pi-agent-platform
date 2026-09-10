<script setup lang="ts">
/**
 * ContextUsage — shows how much of the model's context window is used.
 *
 * Renders as a small ring + percentage inside the InputBox toolbar. Hovering
 * shows a custom tooltip with per-row details (used / limit / remaining /
 * percent) using comma-grouped integers — keeps precision so a developer can
 * see e.g. "12,543 / 200,000 (6.27%)" at a glance instead of "12.5k".
 *
 * Data source: `sse.contextCache.contextUsage` (filled by loadContext, refreshed
 * on each `agent_end` SSE event — see useSSE.ts).
 *
 * Edge cases:
 *   - contextUsage === null  → model has no registered contextWindow, or no
 *     worker is alive → render an em-dash, no ring; tooltip says "unknown"
 *   - tokens === null (SDK returns null right after a compaction, before the
 *     next LLM response) → ring shows 0% + "—%", tooltip says "estimating…"
 *   - percent > 100 → clamped visually, tooltip shows the actual number with
 *     a warning color so the user knows they're past the window
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useSSE } from '../../composables/useSSE'

const props = defineProps<{ sessionId: string }>()

const sse = useSSE({ sessionId: props.sessionId })

const usage = computed(() => sse.contextCache.value?.contextUsage ?? null)

const RING_SIZE = 14
const RING_STROKE = 2
const RING_R = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R

const percentDisplay = computed<string>(() => {
  const u = usage.value
  if (!u) return '—'
  if (u.percent === null) return '—'
  // Two-decimal precision is overkill for a 0–100 indicator; round.
  return Math.round(u.percent).toString()
})

const ringOffset = computed<string>(() => {
  const u = usage.value
  if (!u || u.percent === null) return RING_CIRCUMFERENCE.toString()
  // percent: 0–100, but cap at 100 for the visual (overflow state uses color)
  const clamped = Math.max(0, Math.min(100, u.percent))
  return (RING_CIRCUMFERENCE * (1 - clamped / 100)).toString()
})

/** Color tiers — green / amber / red as the window fills up. */
const ringColor = computed<string>(() => {
  const u = usage.value
  if (!u || u.percent === null) return 'var(--text-secondary)'
  if (u.percent >= 90) return 'var(--tool-error-text, #b71c1c)'
  if (u.percent >= 70) return 'var(--tool-running-text, #e65100)'
  return 'var(--user-bubble-bg, #3577E9)'
})

// ── Tooltip ──
// Custom tooltip instead of native `title`: JCEF delays native tooltips
// hundreds of ms and sometimes swallows them entirely. A Vue-controlled
// overlay opens instantly on hover and lets us format multi-line detail.

const showTip = ref(false)
let hideTimer: number | null = null

function openTip() {
  if (hideTimer !== null) {
    clearTimeout(hideTimer)
    hideTimer = null
  }
  showTip.value = true
}

function closeTip() {
  // small grace period so quick mouse-overs don't flicker the tooltip
  hideTimer = window.setTimeout(() => {
    showTip.value = false
    hideTimer = null
  }, 80)
}

interface DetailRow {
  label: string
  value: string
  warn?: boolean
}

const tooltipRows = computed<{ title: string; rows: DetailRow[] } | null>(() => {
  const u = usage.value
  if (!u) {
    return {
      title: 'Context window',
      rows: [{ label: 'status', value: 'unknown', warn: true }],
    }
  }

  const limit = u.contextWindow
  const hasLimit = limit > 0
  const tokensKnown = u.tokens !== null
  const percentKnown = u.percent !== null

  const rows: DetailRow[] = []

  // Used tokens (or "estimating…")
  if (tokensKnown) {
    rows.push({ label: 'used', value: formatInt(u.tokens as number) })
  } else {
    rows.push({ label: 'used', value: 'estimating…', warn: true })
  }

  // Limit (or "—" if model has no registered contextWindow)
  if (hasLimit) {
    rows.push({ label: 'limit', value: formatInt(limit) })
  } else {
    rows.push({ label: 'limit', value: '—', warn: true })
  }

  // Remaining = limit - used (only meaningful when both known)
  if (hasLimit && tokensKnown) {
    const remaining = Math.max(0, limit - (u.tokens as number))
    rows.push({ label: 'remaining', value: formatInt(remaining) })
  }

  // Percent — with overflow warning if > 100
  if (percentKnown) {
    const pct = u.percent as number
    const formatted = pct >= 100 ? `${pct.toFixed(1)}% (over)` : `${pct.toFixed(2)}%`
    rows.push({ label: 'usage', value: formatted, warn: pct > 100 })
  } else {
    rows.push({ label: 'usage', value: '—', warn: true })
  }

  return { title: 'Context window', rows }
})

function formatInt(n: number): string {
  // Locale-grouped integer (e.g. 12,543) — keeps full precision so the
  // developer can see actual token counts, not rounded "12.5k" approximations.
  return Math.round(n).toLocaleString('en-US')
}

// Position the tooltip above the trigger. Capture the rect on open via a
// watcher — needed because Teleport renders into <body>, not relative to the
// trigger, so we have to compute absolute coords at open-time.
const tipAnchor = ref<{ left: number; top: number; width: number } | null>(null)

const tipStyle = computed(() => {
  const r = tipAnchor.value
  if (!r) return { left: '0px', top: '0px' }
  return {
    left: `${r.left + r.width / 2}px`,
    top: `${r.top - 6}px`,
  }
})

watch(showTip, async (open) => {
  if (!open) return
  // One rAF so the trigger element is laid out before we read its rect.
  await new Promise(requestAnimationFrame)
  const trigger = document.querySelector('.context-usage')
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  tipAnchor.value = { left: rect.left, top: rect.top, width: rect.width }
})

onBeforeUnmount(() => {
  if (hideTimer !== null) clearTimeout(hideTimer)
})
</script>

<template>
  <span
    class="context-usage"
    @mouseenter="openTip"
    @mouseleave="closeTip"
  >
    <svg
      class="context-ring"
      :width="RING_SIZE"
      :height="RING_SIZE"
      :viewBox="`0 0 ${RING_SIZE} ${RING_SIZE}`"
      aria-hidden="true"
    >
      <!-- Track -->
      <circle
        :cx="RING_SIZE / 2"
        :cy="RING_SIZE / 2"
        :r="RING_R"
        class="ring-track"
        :stroke-width="RING_STROKE"
        fill="none"
      />
      <!-- Progress -->
      <circle
        :cx="RING_SIZE / 2"
        :cy="RING_SIZE / 2"
        :r="RING_R"
        :stroke="ringColor"
        :stroke-width="RING_STROKE"
        fill="none"
        stroke-linecap="round"
        :stroke-dasharray="RING_CIRCUMFERENCE"
        :stroke-dashoffset="ringOffset"
        :transform="`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`"
      />
    </svg>
    <span class="context-pct" :style="{ color: ringColor }">{{ percentDisplay }}%</span>

    <!-- Teleport to body so the tooltip escapes the InputBox's overflow:hidden
         wrapper. Positioned via fixed + transform in tipStyle. -->
    <Teleport v-if="showTip && tooltipRows" to="body">
      <div
        class="context-tip"
        :style="tipStyle"
        role="tooltip"
      >
        <div class="context-tip-title">{{ tooltipRows.title }}</div>
        <div
          v-for="row in tooltipRows.rows"
          :key="row.label"
          class="context-tip-row"
        >
          <span class="context-tip-label">{{ row.label }}</span>
          <span
            class="context-tip-value"
            :class="{ 'context-tip-warn': row.warn }"
          >{{ row.value }}</span>
        </div>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.context-usage {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-secondary);
  padding: 2px 6px;
  user-select: none;
  cursor: default;
}

.context-ring {
  flex-shrink: 0;
  display: block;
}

.ring-track {
  stroke: var(--border);
}

.context-pct {
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  line-height: 1;
  min-width: 30px;
  text-align: left;
}

.context-tip {
  position: fixed;
  transform: translate(-50%, -100%);
  background: var(--bg-primary, #1f2125);
  border: 1px solid var(--border, #3a3d42);
  border-radius: 4px;
  padding: 8px 10px;
  font-size: 11px;
  color: var(--text);
  box-shadow: var(--shadow-raised);
  z-index: 1000;
  min-width: 160px;
  pointer-events: none;
}

.context-tip-title {
  font-weight: 600;
  font-size: 11px;
  color: var(--text-secondary);
  margin-bottom: 4px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border, #3a3d42);
}

.context-tip-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-variant-numeric: tabular-nums;
  line-height: 1.6;
}

.context-tip-label {
  color: var(--text-secondary);
}

.context-tip-value {
  color: var(--text);
}

.context-tip-warn {
  color: var(--tool-error-text, #e5484d);
}
</style>