/**
 * 插件注册的一级菜单（响应式缓存）。
 *
 * 为什么单独一个模块：`nav-tree` 是 `computed`，而插件菜单来自运行时 HTTP，
 * 不是路由表——所以需要一个自己的 `shallowRef` 让依赖能重建。
 */

import { shallowRef, type ShallowRef } from 'vue';
import type { WithPlugin } from '@pi-agent-platform/api-types';
import type { MenuRegistration } from '@pi-agent-platform/plugin-types';
import { listPluginMenus } from './host';

const menus: ShallowRef<Array<WithPlugin<MenuRegistration>>> = shallowRef([]);

export const pluginMenus = menus;

/** 拉一次注册表（应用启动、插件启停后调用）。失败时清空，不让导航崩。 */
export async function refreshPluginMenus(): Promise<void> {
  try {
    menus.value = await listPluginMenus();
  } catch (err) {
    console.warn('[plugin] refresh menus failed', err);
    menus.value = [];
  }
}

/** 插件页的路径（菜单点击目标）。 */
export function pluginPagePath(menu: { pluginId: string; page: string }): string {
  return `/plugin-page/${encodeURIComponent(menu.pluginId)}/${encodeURIComponent(menu.page)}`;
}
