<script setup lang="ts">
/**
 * 插件槽位宿主（change: plugin-mechanism 6.3 / 6.5）。
 *
 * 一个槽位对应页面上的一处挂载点。插件只能往自己那块容器里画，宿主不透露
 * 任何内部状态；这样插件面板出错不会污染会话页。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PluginSlotName } from '@pi-agent-platform/plugin-types'
import { mountSlot } from '../../plugins/host'

const props = defineProps<{
  slot: PluginSlotName
  sessionId?: string
  /** 只挂某个插件（抽屉按插件打开时用）。 */
  pluginId?: string
}>()

const el = ref<HTMLElement | null>(null)
let cleanup: (() => void) | null = null
let disposed = false

async function refresh() {
  cleanup?.()
  cleanup = null
  if (!el.value) return
  const unmount = await mountSlot(el.value, props.slot, {
    sessionId: props.sessionId,
    onlyPluginId: props.pluginId,
  })
  if (disposed) {
    unmount()
    return
  }
  cleanup = unmount
}

onMounted(() => {
  void refresh()
})

watch(
  () => [props.slot, props.sessionId, props.pluginId],
  () => void refresh(),
)

onBeforeUnmount(() => {
  disposed = true
  cleanup?.()
  cleanup = null
})
</script>

<template>
  <div ref="el" class="plugin-slot-host" :data-slot="slot" />
</template>

<style scoped>
/* 空槽位不占位：没有插件时宿主自己消失，不留下空白边距 */
.plugin-slot-host:empty {
  display: none;
}
</style>
