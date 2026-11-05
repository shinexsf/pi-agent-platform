<!--
  PluginToolCard — 整卡替换（`mode: 'replace'`）。

  插件拿到整张卡片的内容区：平台不再渲染头部与折叠，插件自己决定长什么样。
  想复用平台观感时可以调 `host.toolCard.shell()`，但那是可选的。
-->
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { WithPlugin } from '@pi-agent-platform/api-types';
import type { ToolCardRegistration } from '@pi-agent-platform/plugin-types';
import { mountToolCard } from '../../../plugins/host';
import { toSnapshot } from './toSnapshot';
import { ruleFor } from './pluginToolCards';
import type { ToolCall } from './types';

const props = defineProps<{
  rule: WithPlugin<ToolCardRegistration>;
  call: ToolCall;
  streaming: boolean;
  sessionId?: string;
}>();

const hostEl = ref<HTMLElement | null>(null);
let unmount: (() => void) | null = null;
let listeners = new Set<(snapshot: ReturnType<typeof toSnapshot>) => void>();

function emit(): void {
  const snapshot = toSnapshot(props.call, props.streaming);
  for (const fn of listeners) {
    try {
      fn(snapshot);
    } catch (err) {
      console.warn('[plugin] tool card subscriber failed', err);
    }
  }
}

async function mount(): Promise<void> {
  unmount?.();
  unmount = null;
  listeners = new Set();
  if (!hostEl.value || !props.rule.entry) return;
  hostEl.value.innerHTML = '';
  unmount = await mountToolCard(hostEl.value, props.rule, props.rule.entry, {
    sessionId: props.sessionId,
    snapshot: toSnapshot(props.call, props.streaming),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  });
}

onMounted(mount);
watch(() => [props.call.result, props.call.isError, props.streaming], emit);
watch(() => props.rule.pluginId, mount);
onBeforeUnmount(() => {
  unmount?.();
  unmount = null;
  listeners.clear();
});

// 供模板判断（规则缺失时不应渲染本组件，这里只是防御）
const hasRule = () => Boolean(ruleFor(props.call.name, [props.rule]));
</script>

<template>
  <div ref="hostEl" v-if="hasRule()" class="plugin-tool-card" />
</template>

<style scoped>
.plugin-tool-card {
  margin: 8px 0;
}
</style>
