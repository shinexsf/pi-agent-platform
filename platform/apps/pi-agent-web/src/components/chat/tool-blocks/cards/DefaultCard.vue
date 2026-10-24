<!--
  DefaultCard — fallback for every tool without a dedicated card, including the
  whole `mcp__<server>__<tool>` namespace.

  MCP tool names are shown **verbatim**: the server prefix IS how pi names the
  tool, so it is not re-parsed into a badge (there is no nameable "category" for
  a third-party tool anyway — dispatch is by name, see `registry.ts`).

  Body: call arguments as key/value rows + the raw result.
-->
<script setup lang="ts">
import { computed } from 'vue'
import ToolCard from '../ToolCard.vue'
import { firstNonEmptyLine, flattenForPreview, formatArgs } from '../format'
import type { ToolBlockProps } from '../types'

const props = defineProps<ToolBlockProps>()

const args = computed(() => formatArgs(props.call.args ?? {}))
const result = computed(() => (typeof props.call.result === 'string' ? props.call.result : ''))

const preview = computed(() => {
  const first = firstNonEmptyLine(result.value)
  return first ? flattenForPreview(first) : '（无结果）'
})
</script>

<template>
  <ToolCard :call="call" :streaming="streaming" :label="label">
    <!-- No header summary: an unknown tool's arguments have no known semantics, so
         guessing one would be noise. The body carries them instead. -->
    <template #preview>{{ preview }}</template>
    <template #body>
      <div v-if="args.length" class="args">
        <div v-for="arg in args" :key="arg.key" class="arg">
          <span class="k">{{ arg.key }}</span>
          <span class="v">{{ arg.value }}</span>
        </div>
      </div>
      <pre class="out">{{ result || '(no result)' }}</pre>
    </template>
  </ToolCard>
</template>

<style scoped>
.args {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border);
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.6;
}

.arg {
  display: flex;
  gap: 10px;
}

.k {
  color: var(--text-tertiary);
  flex: 0 0 auto;
  min-width: 56px;
}

.v {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--text-secondary);
}

.out {
  margin: 0;
  max-height: 340px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
