/**
 * @deprecated 已被 `plugins/pages.ts` 取代（change: plugin-mechanism-v2 / D10）。
 *
 * 现在只有一份数据：`ui.page({ path, label, icon, component })` 一次注册同时产生
 * 页面与菜单，`/api/extensions` 的 `pages` 已带导航字段。这个文件保留一个版本，
 * 只为让仓内外还引用 `pluginMenus` / `pluginPagePath` 的代码不立刻断。
 *
 * 迁移：`pluginMenus` → `navPages()`（`plugins/pages.ts`）；`refreshPluginMenus()` →
 * `refreshPluginPages()`；`pluginPagePath(menu)` → `pluginPagePath(page)`。
 */

import type { RegistryPageDTO } from '@pi-agent-platform/api-types';
import { navPages, pluginPagePath, refreshPluginPages } from './pages';

/** @deprecated 用 `navPages()`。 */
export function listNavPages(): RegistryPageDTO[] {
  return navPages();
}

/** @deprecated 用 `refreshPluginPages()`。 */
export const refreshPluginMenus = refreshPluginPages;

/** @deprecated 用 `plugins/pages.ts` 的 `pluginPagePath(page)`。 */
export { pluginPagePath };
