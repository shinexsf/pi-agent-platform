<!--
  PluginToolRegion — 把工具卡片的一块区域交给插件渲染（`mode: 'regions'`）。

  只替换被声明的区域；头部（工具名/摘要/状态胶囊/折叠）恒由平台渲染，
  这样插件加一行/一张图不需要复刻流式与折叠交互。
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { WithPlugin } from '@pi-agent-platform/api-types';
import type { ToolCardRegistration, ToolCardRegion } from '@pi-agent-platform/plugin-types';
import { mountToolCard } from '../../../plugins/host';
import { toSnapshot } from './toSnapshot';
import type { ToolCall } from './types';

const props = defineProps<{
  region: ToolCardRegion;
  rule: WithPlugin<ToolCardRegistration>;
  call: ToolCall;
  streaming: boolean;
  sessionId?: string;
}>();

const hostEl = ref<HTMLElement | null>(null);
let unmount: (() => void) | null = null;

async function mount(): Promise<void> {
  unmount?.();
  unmount = null;
  const entry = props.rule.regions?.[props.region];
  if (!hostEl.value || !entry) return;
  hostEl.value.innerHTML = '';
  unmount = await mountToolCard(hostEl.value, props.rule, entry, {
    sessionId: props.sessionId,
    snapshot: toSnapshot(props.call, props.streaming),
    subscribe: () => () => {},
  });
}

onMounted(mount);
// 结果/流式状态变化时重挂：插件拿到的是快照，不需要自己 diff。
watch(() => [props.call.result, props.call.isError, props.streaming, props.rule.pluginId], mount);
onBeforeUnmount(() => {
  unmount?.();
  unmount = null;
});

</script>

<template>
  <div ref="hostEl" class="plugin-tool-region" :data-region="region" />
</template>

<style scoped>
.plugin-tool-region {
  display: block;
}
</style>
