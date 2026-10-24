<!--
  ReadCard — `read` tool: file path + line range in the header, file content in
  the body with a line-number gutter. Clicking the path asks the host to open it.

  pi's `read` may already prefix its output with line numbers (`  12|…`); when the
  first line looks numbered we render the text as-is instead of adding a second
  gutter.
-->
<script setup lang="ts">
import { computed } from 'vue'
import ToolCard from '../ToolCard.vue'
import { argString, countLines, firstNonEmptyLine, flattenForPreview } from '../format'
import type { ToolBlockProps } from '../types'

const props = defineProps<ToolBlockProps>()
const emit = defineEmits<{ 'open-file': [path: string] }>()

const path = computed(() => argString(props.call.args, 'path'))
const offset = computed(() => argString(props.call.args, 'offset'))
const limit = computed(() => argString(props.call.args, 'limit'))
const result = computed(() => (typeof props.call.result === 'string' ? props.call.result : ''))

const range = computed(() => {
  if (!offset.value && !limit.value) return ''
  return offset.value ? ` @${offset.value}${limit.value ? `+${limit.value}` : ''}` : ` ${limit.value} 行`
})

const lines = computed(() => {
  const all = result.value.replace(/\n$/, '').split('\n')
  // pi appends a hint line like `[22 more lines in file. Use offset=7 to continue.]`;
  // it is metadata, not file content, so it must not get a line number.
  const hintIndex = all.findIndex((l) => /^\[\d+ more lines/.test(l.trim()))
  return hintIndex >= 0 ? all.slice(0, hintIndex) : all
})

/** `[22 more lines …]` hint, rendered as a notice under the content instead of a code line. */
const moreHint = computed(() => {
  const m = /^\[(\d+) more lines[^\]]*\]$/m.exec(result.value)
  return m ? m[0] : ''
})
/** pi already numbers lines → don't add a second gutter. */
const preNumbered = computed(
  () => lines.value.length > 1 && /^\s*\d+[|→]\s?/.test(lines.value[0] ?? ''),
)

const preview = computed(() => {
  const first = firstNonEmptyLine(result.value)
  return first ? flattenForPreview(first) : '（空文件）'
})
</script>

<template>
  <ToolCard :call="call" :streaming="streaming" :label="label">
    <template #summary>
      <button class="path-link" type="button" @click.stop="emit('open-file', path)">
        {{ path || '(no path)' }}{{ range }}
      </button>
    </template>
    <template #preview>{{ preview }}</template>
    <template #body>
      <pre v-if="preNumbered" class="content">{{ result }}</pre>
      <div v-else class="numbered">
        <div v-for="(line, i) in lines" :key="i" class="row">
          <span class="ln">{{ i + 1 }}</span>
          <span class="cl">{{ line }}</span>
        </div>
        <div v-if="moreHint" class="more-hint">{{ moreHint }}</div>
      </div>
    </template>
    <template #foot>
      <span>{{ countLines(result) }} 行</span>
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

.content {
  margin: 0;
  padding: 8px 10px;
  max-height: 340px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.numbered {
  max-height: 340px;
  overflow: auto;
  padding: 6px 0;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
}

.row {
  display: flex;
  gap: 10px;
  padding: 0 10px;
}

.row:hover {
  background: var(--surface-hover);
}

.ln {
  flex: 0 0 auto;
  width: 32px;
  text-align: right;
  color: var(--text-tertiary);
  user-select: none;
}

.cl {
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.more-hint {
  margin: 6px 10px 2px;
  padding: 3px 8px;
  border-radius: 4px;
  background: var(--surface-hover);
  color: var(--text-tertiary);
  font-size: 11.5px;
}
</style>
