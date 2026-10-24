<!--
  FetchCard — `fetch` / `web_fetch` / `web_search`: the URL or query in the
  header, fetched content in the body.
-->
<script setup lang="ts">
import { computed } from 'vue'
import ToolCard from '../ToolCard.vue'
import { argString, countLines, firstNonEmptyLine, flattenForPreview } from '../format'
import type { ToolBlockProps } from '../types'

const props = defineProps<ToolBlockProps>()

const target = computed(
  () =>
    argString(props.call.args, 'url') ||
    argString(props.call.args, 'query') ||
    argString(props.call.args, 'path'),
)

const result = computed(() => (typeof props.call.result === 'string' ? props.call.result : ''))

const preview = computed(() => {
  const first = firstNonEmptyLine(result.value)
  return first ? flattenForPreview(first) : '（空响应）'
})
</script>

<template>
  <ToolCard :call="call" :streaming="streaming" :label="label">
    <template #summary>{{ target }}</template>
    <template #preview>{{ preview }}</template>
    <template #body>
      <pre class="out">{{ result || '(empty)' }}</pre>
    </template>
    <template #foot>
      <span>{{ countLines(result) }} 行</span>
    </template>
  </ToolCard>
</template>

<style scoped>
.out {
  margin: 0;
  max-height: 340px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
