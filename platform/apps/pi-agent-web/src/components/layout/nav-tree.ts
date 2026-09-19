/**
 * nav-tree — 抽屉导航树（一级 + 二级）单一事实来源。
 *
 * 一级项：从 Vue Router 的路由表读取带 `meta.navLabel` 的路由（沿用改造前
 *   TopNav 的数据驱动方式，新增 `meta.mobileHidden`）。
 * 二级项：
 *   - `/config` → `views/config/sections.ts` 的 CONFIG_SECTIONS
 *   - `/im`     → manifest 动态发现的启用渠道
 *
 * 二级菜单折叠契约（design.md D3）：超过 `MAX_VISIBLE_SECONDARY` 项时
 * 默认只显示前 N 项 + 「更多」。
 */
import { computed, type ComputedRef } from 'vue';
import { useRouter } from 'vue-router';
import { CONFIG_SECTIONS } from '../../views/config/sections';
import { useChannelList } from '../../modules/im-gateway/useChannelList';

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
  if (path.includes('/architecture')) return 'architecture';
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
  const { channels } = useChannelList();

  function childrenFor(path: string): NavLeaf[] {
    if (path === '/config') {
      return CONFIG_SECTIONS.map((section) => ({
        path: `/config/${section.id}`,
        label: section.label,
      }));
    }
    if (path === '/im') {
      return channels.value.map((channel) => ({
        path: `/im/${channel.channelType}`,
        label: channel.displayName,
      }));
    }
    return [];
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
        children: childrenFor(navPath),
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
