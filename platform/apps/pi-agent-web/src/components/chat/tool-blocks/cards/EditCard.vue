<!--
  EditCard — `edit` tool: diff-style body (removed lines in red with `-`, added
  lines in green with `+`) plus the file path in the header.
-->
<script setup lang="ts">
import { computed } from 'vue'
import ToolCard from '../ToolCard.vue'
import { argString, countLines } from '../format'
import type { ToolBlockProps } from '../types'

const props = defineProps<ToolBlockProps>()
const emit = defineEmits<{ 'open-file': [path: string] }>()

const path = computed(() => argString(props.call.args, 'path'))
const before = computed(() => argString(props.call.args, 'oldText'))
const after = computed(() => argString(props.call.args, 'newText'))
const removedLines = computed(() => (before.value ? countLines(before.value) : 0))
const addedLines = computed(() => (after.value ? countLines(after.value) : 0))

/** Plain line diff: every removed line, then every added line. */
const rows = computed(() => {
  const out: Array<{ sign: '-' | '+'; text: string }> = []
  for (const line of before.value.split('\n')) out.push({ sign: '-', text: line })
  for (const line of after.value.split('\n')) out.push({ sign: '+', text: line })
  return out
})
</script>

<template>
  <ToolCard :call="call" :streaming="streaming" :label="label">
    <template #summary>
      <button class="path-link" type="button" @click.stop="emit('open-file', path)">
        {{ path || '(no path)' }}
      </button>
    </template>
    <template #preview>-{{ removedLines }} +{{ addedLines }}</template>
    <template #body>
      <pre class="diff"><span
        v-for="(row, i) in rows"
        :key="i"
        :class="row.sign === '-' ? 'del' : 'add'"
      >{{ row.sign }} {{ row.text }}
</span></pre>
    </template>
    <template #foot>
      <span class="del">-{{ removedLines }}</span>
      <span class="add">+{{ addedLines }}</span>
    </template>
  </ToolCard>
</template>

<style scoped>
.path-link {
  background: none;
  border: 0;
  padding: 0;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--accent);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.diff {
  margin: 0;
  max-height: 340px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.del {
  color: var(--danger);
}

.add {
  color: var(--success);
}
</style>
