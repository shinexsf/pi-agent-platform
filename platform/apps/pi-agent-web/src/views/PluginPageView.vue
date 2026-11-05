<script setup lang="ts">
/**
 * 插件页面（`/plugin-page/:pluginId/:pageId`）。
 *
 * 菜单不直接进 Vue Router（路由表运行期变化不触发 nav-tree 重算），
 * 所以所有插件页共用这一条静态路由，由参数决定渲染谁。
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
  const pluginId = String(route.params.pluginId ?? '');
  const pageId = String(route.params.pageId ?? '');
  unmount = await mountPluginPage(el, pluginId, pageId);
}

onMounted(load);
watch(() => [route.params.pluginId, route.params.pageId], load);
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
