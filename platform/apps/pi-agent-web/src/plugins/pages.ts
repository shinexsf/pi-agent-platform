/**
 * 插件页面（响应式缓存）—— 导航与路由的**唯一**数据源。
 *
 * 为什么不再有 `menus.ts`：`ui.page({ path, label, icon, component })` 是**一次注册**，
 * 服务端的 `/api/extensions` 已经把菜单字段摊到页面上，前端再 join 两遍就是双源。
 *
 * 为什么页面不进 `router.getRoutes()` 的静态表：插件页是运行期注册的，而 `nav-tree`
 * 是 `computed`（依赖 router 的响应式版本），动态 `addRoute` 时它不会自己重算 ——
 * 所以导航读这个 `shallowRef`，路由用 `syncPluginRoutes()` 增量登记。
 */

import { shallowRef, type ShallowRef } from 'vue';
import type { Router } from 'vue-router';
import type { RegistryPageDTO } from '@pi-agent-platform/api-types';
import { loadGlobalExtensions } from './host';

const pages: ShallowRef<RegistryPageDTO[]> = shallowRef([]);

export const pluginPages = pages;

/** 拉一次注册表（启动、插件启停后调用）。失败时清空，不让导航崩。 */
export async function refreshPluginPages(): Promise<void> {
  try {
    const body = await loadGlobalExtensions(true);
    pages.value = body.disabledByFlag ? [] : body.pages;
  } catch (err) {
    console.warn('[plugin] refresh pages failed', err);
    pages.value = [];
  }
}

/** 旧的兜底路径：没有自报 `path` 的插件页走这条静态路由。 */
export function legacyPluginPagePath(page: { pluginId: string; id: string }): string {
  return `/plugin-page/${encodeURIComponent(page.pluginId)}/${encodeURIComponent(page.id)}`;
}

/** 该页面的可点击路径（优先用作者声明的 `path`）。 */
export function pluginPagePath(page: RegistryPageDTO): string {
  return page.path && page.path.startsWith('/') ? page.path : legacyPluginPagePath(page);
}

/** 进导航的页面（有 label 才显示）。 */
export function navPages(): RegistryPageDTO[] {
  return pages.value.filter((page) => typeof page.label === 'string' && page.label);
}

const PREFIX = 'plugin-page:';

/**
 * 把插件的真实路径登记进路由（`/im/channels` 这类）。
 *
 * 与内置路由冲突时**不抢**：退回兜底路径，避免插件把平台页面覆盖掉。
 * 先删上一轮登记的，`refreshPluginPages()` 之后调用即可。
 */
export function syncPluginRoutes(router: Router): void {
  for (const existing of router.getRoutes()) {
    if (typeof existing.name === 'string' && existing.name.startsWith(PREFIX)) {
      router.removeRoute(existing.name);
    }
  }
  const taken = new Set(router.getRoutes().map((r) => r.path));
  for (const page of pages.value) {
    const path = pluginPagePath(page);
    if (taken.has(path)) continue;
    taken.add(path);
    router.addRoute({
      path,
      name: `${PREFIX}${page.pluginId}:${page.id}`,
      component: () => import('../views/PluginPageView.vue'),
      meta: { fullWidth: true, pluginId: page.pluginId, pageId: page.id },
    });
  }

  // 冷启动直接访问插件页（如刷新 /notifications）时，路由是**后加**的：
  // 首帧匹配不到任何路由 → `<main>` 空白。这里补一次重新解析。
  const current = router.currentRoute.value;
  if (current.matched.length === 0) {
    void router.replace(current.fullPath);
  }
}
