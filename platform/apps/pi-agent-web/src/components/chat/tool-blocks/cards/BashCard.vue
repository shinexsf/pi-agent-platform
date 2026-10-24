<!--
  BashCard — `bash` / `shell` / `powershell`.

  Rendered as a terminal: the command sits on a prompt line (`$`, accent), the
  output follows on the code surface, and a block cursor trails the output while
  the call is still streaming.
-->
<script setup lang="ts">
import { computed } from 'vue'
import ToolCard from '../ToolCard.vue'
import { argString, countLines, firstNonEmptyLine, flattenForPreview } from '../format'
import type { ToolBlockProps } from '../types'

const props = defineProps<ToolBlockProps>()

const command = computed(() => argString(props.call.args, 'command').replace(/\s+/g, ' ').trim())
const timeout = computed(() => argString(props.call.args, 'timeout'))
const output = computed(() => (typeof props.call.result === 'string' ? props.call.result : ''))

const preview = computed(() => {
  const first = firstNonEmptyLine(output.value)
  return first ? flattenForPreview(first) : '（无输出）'
})
</script>

<template>
  <ToolCard :call="call" :streaming="streaming" :label="label">
    <template #summary>$ {{ command }}</template>
    <template #preview>{{ preview }}</template>
    <template #body>
      <div class="term">
        <div class="term-cmd"><span class="prompt">$</span> {{ command }}</div>
        <pre class="term-out">{{ output }}<span v-if="streaming" class="cursor">▌</span></pre>
      </div>
    </template>
    <template #foot>
      <span v-if="timeout" class="chip">timeout {{ timeout }}</span>
      <span>{{ countLines(output) }} 行输出</span>
    </template>
  </ToolCard>
</template>

<style scoped>
.term {
  background: var(--code-bg, rgb(15 23 42 / 0.04));
}

.term-cmd {
  padding: 7px 10px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
  border-bottom: 1px dashed var(--border);
  white-space: pre-wrap;
  word-break: break-all;
}

.prompt {
  color: var(--accent);
  font-weight: 700;
  margin-right: 2px;
}

.term-out {
  margin: 0;
  padding: 8px 10px;
  max-height: 320px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.cursor {
  display: inline-block;
  margin-left: 1px;
  color: var(--accent);
  animation: blink 1s steps(2, start) infinite;
}

@keyframes blink {
  to {
    opacity: 0;
  }
}

.chip {
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
}
</style>
