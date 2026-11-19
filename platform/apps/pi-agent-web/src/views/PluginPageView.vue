<script setup lang="ts">
/**
 * 插件页面。
 *
 * 两种入口：
 * - 插件声明了自己的 `path`（`/probe`）→ 运行期 `router.addRoute` 登记，参数在 `meta`
 * - 旧式插件没有 `path` → 落到静态路由 `/plugin-page/:pluginId/:pageId`
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { mountPluginPage } from '../plugins/host';

const route = useRoute();
const hostEl = ref<HTMLElement | null>(null);
let unmount: (() => void) | null = null;

async function load(): Promise<void> {
  unmount?.();
  unmount = null;
  const el = hostEl.value;
  if (!el) return;
  el.innerHTML = '';
  const pluginId = String(route.meta.pluginId ?? route.params.pluginId ?? '');
  const pageId = String(route.meta.pageId ?? route.params.pageId ?? '');
  unmount = await mountPluginPage(el, pluginId, pageId);
}

onMounted(load);
watch(() => [route.meta.pluginId ?? route.params.pluginId, route.meta.pageId ?? route.params.pageId], load);
onBeforeUnmount(() => {
  unmount?.();
  unmount = null;
});
</script>

<template>
  <div ref="hostEl" class="plugin-page" />
</template>

<style scoped>
.plugin-page {
  padding: 20px 24px;
}
@media (max-width: 640px) {
  .plugin-page {
    padding: 12px 14px;
  }
}
</style>
