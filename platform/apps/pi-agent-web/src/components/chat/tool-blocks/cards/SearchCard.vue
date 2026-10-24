<!--
  SearchCard — `grep` / `find` / `ls`: query (pattern / glob / directory) in the
  header, matches as rows in the body.

  A `path:line:snippet` line (grep output) is split into three columns so the
  file name and line number are scannable; anything else is shown verbatim.
-->
<script setup lang="ts">
import { computed } from 'vue'
import ToolCard from '../ToolCard.vue'
import { argString, countLines, firstNonEmptyLine, flattenForPreview } from '../format'
import type { ToolBlockProps } from '../types'

const props = defineProps<ToolBlockProps>()

const query = computed(() => {
  const pattern = argString(props.call.args, 'pattern') || argString(props.call.args, 'glob')
  const target = argString(props.call.args, 'path') || argString(props.call.args, 'cwd')
  if (pattern && target) return `${pattern}  in  ${target}`
  return pattern || target || argString(props.call.args, 'query')
})

const result = computed(() => (typeof props.call.result === 'string' ? props.call.result : ''))

interface Row {
  file: string
  line: string
  text: string
}

const rows = computed<Row[]>(() =>
  result.value
    .replace(/\n$/, '')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((raw) => {
      const m = /^(.+?):(\d+):(.*)$/.exec(raw)
      if (m && m[1] && m[2]) return { file: m[1], line: m[2], text: (m[3] ?? '').trim() }
      return { file: '', line: '', text: raw }
    }),
)

const preview = computed(() => {
  const first = firstNonEmptyLine(result.value)
  return first ? flattenForPreview(first) : '（无匹配）'
})
</script>

<template>
  <ToolCard :call="call" :streaming="streaming" :label="label">
    <template #summary>{{ query }}</template>
    <template #preview>{{ preview }}</template>
    <template #body>
      <div v-if="rows.length" class="matches">
        <div v-for="(row, i) in rows" :key="i" class="row">
          <template v-if="row.file">
            <span class="file" :title="row.file">{{ row.file }}</span>
            <span class="ln">{{ row.line }}</span>
          </template>
          <span class="text">{{ row.text }}</span>
        </div>
      </div>
      <pre v-else class="out">(no matches)</pre>
    </template>
    <template #foot>
      <span>{{ rows.length }} 条结果</span>
    </template>
  </ToolCard>
</template>

<style scoped>
.matches {
  max-height: 340px;
  overflow: auto;
  padding: 6px 0;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.65;
}

.row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 10px;
}

.row:hover {
  background: var(--surface-hover);
}

.file {
  flex: 0 1 auto;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--accent);
}

.ln {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

.text {
  flex: 1 1 auto;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.out {
  margin: 0;
  padding: 8px 10px;
  max-height: 340px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
