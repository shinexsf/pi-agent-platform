<!--
  WriteCard — `write` tool: path in the header, the new file content as added
  lines in green.
-->
<script setup lang="ts">
import { computed } from 'vue'
import ToolCard from '../ToolCard.vue'
import { argString, countLines } from '../format'
import type { ToolBlockProps } from '../types'

const props = defineProps<ToolBlockProps>()
const emit = defineEmits<{ 'open-file': [path: string] }>()

const path = computed(() => argString(props.call.args, 'path'))
const content = computed(() => argString(props.call.args, 'content'))
const lines = computed(() => countLines(content.value))
</script>

<template>
  <ToolCard :call="call" :streaming="streaming" :label="label">
    <template #summary>
      <button class="path-link" type="button" @click.stop="emit('open-file', path)">
        {{ path || '(no path)' }}
      </button>
    </template>
    <template #preview>{{ lines }} 行新内容</template>
    <template #body>
      <pre class="content"><span class="add">{{ content }}</span></pre>
    </template>
    <template #foot>
      <span class="add">+{{ lines }}</span>
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
  max-height: 340px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.add {
  color: var(--success);
}
</style>
