<script setup lang="ts">
import { useIdeBridge } from '../composables/useIdeBridge'
import { Methods } from '../bridge/methods'

const props = defineProps<{
  path: string
  line?: number
}>()

const bridge = useIdeBridge()

async function handleClick(e: MouseEvent) {
  e.preventDefault()
  try {
    // bridge.invoke resolves with data directly; rejects on error.
    await bridge.invoke<void>(Methods.OPEN_FILE, {
      path: props.path,
      options: { line: props.line },
    })
  } catch (err) {
    console.warn('[FileLink] openFile failed:', err)
  }
}
</script>

<template>
  <a class="tool-file-link" href="#" @click="handleClick">{{ path }}{{ line ? `:${line}` : '' }}</a>
</template>

<style scoped>
.tool-file-link {
  color: var(--link);
  text-decoration: none;
  cursor: pointer;
}
.tool-file-link:hover {
  text-decoration: underline;
}
</style>