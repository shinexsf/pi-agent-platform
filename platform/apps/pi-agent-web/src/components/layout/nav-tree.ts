/**
 * nav-tree — 抽屉导航树（一级 + 二级）单一事实来源。
 *
 * 一级项：从 Vue Router 的路由表读取带 `meta.navLabel` 的路由（沿用改造前
 *   TopNav 的数据驱动方式，新增 `meta.mobileHidden`）。
 * 二级项：
 *   - `/config` → `views/config/sections.ts` 的 CONFIG_SECTIONS
 *   - 其余一级项 → 插件声明的 `parent` 页面（`ui.page({ parent: '/im' })`）
 *
 * 渠道清单不再由前端硬编码：IM 网关与各渠道都是插件，二级项一律来自页面注册表。
 *
 * 二级菜单折叠契约（design.md D3）：超过 `MAX_VISIBLE_SECONDARY` 项时
 * 默认只显示前 N 项 + 「更多」。
 */
import { computed, type ComputedRef } from 'vue';
import { useRouter } from 'vue-router';
import { CONFIG_SECTIONS } from '../../views/config/sections';
import { navPages, pluginPagePath } from '../../plugins/pages';

/** 二级菜单默认可见项上限。 */
export const MAX_VISIBLE_SECONDARY = 4;

export interface NavLeaf {
  path: string;
  label: string;
}

export interface NavNode {
  path: string;
  label: string;
  icon?: string;
  order: number;
  mobileHidden: boolean;
  children: NavLeaf[];
}

interface NavMeta {
  navLabel?: unknown;
  navOrder?: unknown;
  navIcon?: unknown;
  mobileHidden?: unknown;
}

/** 取路径参数前的静态前缀：`/config/:section?` → `/config`，`/agents` → `/agents`。 */
function navPathOf(path: string): string {
  const segments = path.split('/').filter(Boolean);
  const staticSegments: string[] = [];
  for (const segment of segments) {
    if (segment.startsWith(':')) break;
    staticSegments.push(segment);
  }
  return `/${staticSegments.join('/')}`;
}

/** 路由 path → AppIcon 名称的兜底映射（保留改造前 TopNav 的行为）。 */
function fallbackIcon(path: string): string {
  if (path.includes('/config')) return 'settings';
  if (path.includes('/im')) return 'im';
  if (path.includes('/sessions')) return 'sessions';
  return 'agents';
}

function resolveIcon(path: string, raw: unknown): string {
  if (typeof raw === 'string' && raw && !/[\p{Extended_Pictographic}]/u.test(raw)) {
    return raw;
  }
  return fallbackIcon(path);
}

export function useNavTree(): {
  nodes: ComputedRef<NavNode[]>;
  maxVisibleSecondary: number;
} {
  const router = useRouter();

  function childrenFor(path: string): NavLeaf[] {
    if (path === '/config') {
      const builtin = CONFIG_SECTIONS.map((section) => ({
        path: `/config/${section.id}`,
        label: section.label,
      }));
      // 插件可以向 config 下挂二级项（`parent: 'config'`），拼在内置项之后。
      const pluginItems = navPages()
        .filter((page) => page.parent === 'config')
        .map((page) => ({ path: pluginPagePath(page), label: page.label as string }));
      return [...builtin, ...pluginItems];
    }
    return [];
  }

  /**
   * 插件页挂到某个一级项下的**通用**渠道：`ui.page({ parent: '/im' })`。
   *
   * 跨插件挂载只认路径字符串；父页不存在（父插件被禁用）时，调用方把该页降级为一级项
   * （见下方 `nodes` 里的兜底），不静默隐藏入口。
   */
  function pluginChildrenFor(path: string): NavLeaf[] {
    return navPages()
      .filter((page) => page.parent === path)
      .map((page) => ({ path: pluginPagePath(page), label: page.label as string }));
  }

  const nodes = computed<NavNode[]>(() => {
    const list: NavNode[] = [];
    const seen = new Set<string>();
    for (const record of router.getRoutes()) {
      const meta = record.meta as NavMeta;
      if (typeof meta.navLabel !== 'string' || !meta.navLabel) continue;
      // 取参数前的静态前缀作为导航路径：`/config/:section?` → `/config`。
      // 这样带可选参数的一级路由（IM / 配置）与无参路由可以统一处理。
      const navPath = navPathOf(record.path);
      if (!navPath || navPath === '/' || seen.has(navPath)) continue;
      seen.add(navPath);
      list.push({
        path: navPath,
        label: meta.navLabel,
        icon: resolveIcon(navPath, meta.navIcon),
        order: typeof meta.navOrder === 'number' ? meta.navOrder : 100,
        mobileHidden: meta.mobileHidden === true,
        children: [...childrenFor(navPath), ...pluginChildrenFor(navPath)],
      });
    }
    list.sort((a, b) => a.order - b.order);

    // 插件页：读 `pages` 这一份合一数据（不再 join menus/pages）。
    // 页面路径由插件声明（`/probe`），与内置路由冲突时退回归一路径。
    //
    // 二级归属要**两轮**：一级项既可能来自内置路由（`/config`），也可能来自插件页（`/im`），
    // 而子页声明的 `parent` 只认路径字符串 —— 一轮遍历时插件的父页还没进 list，子页就会被
    // 误当成一级项（IM → QQ 平级）。所以先把一级项收齐，再挂子页。
    const topLevel = new Set(list.map((node) => node.path));
    const pluginPages = navPages();
    const topLevelPluginPages = pluginPages.filter((page) => !page.parent || !topLevel.has(page.parent));
    for (const page of topLevelPluginPages) topLevel.add(pluginPagePath(page));

    for (const page of pluginPages) {
      // 已挂到某个**存在的**一级项下的页面不再是单独的一级项（父页不存在 → 降级为一级项）。
      if (page.parent && topLevel.has(page.parent)) continue;
      const path = pluginPagePath(page);
      list.push({
        path,
        label: page.label as string,
        icon: resolveIcon('', page.icon),
        // 插件项缺省排在内置项之后，但仍低于 200（留给未来的系统项）
        order: typeof page.order === 'number' ? 200 + page.order : 300,
        mobileHidden: false,
        children: pluginChildrenFor(path),
      });
    }
    list.sort((a, b) => a.order - b.order);
    return list;
  });

  return { nodes, maxVisibleSecondary: MAX_VISIBLE_SECONDARY };
}

/** 判断 `path` 是否落在 `base` 之内（自身或子路径）。 */
export function isWithin(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}
