/**
 * 顶栏图标动作区（扩展点 R11）。
 *
 * 为什么单独一个模块：顶栏是**全局 chrome**，它既不属于某个页面，也不该被插件直接改 DOM。
 * 数据来自 `/api/extensions` 的 `headerActions`（服务端注册），浏览器只负责三件事：
 *
 * 1. **平铺 / 收起**：桌面全平铺；窄屏只留前 N 个，其余进「更多」菜单
 *    （GitHub 右上角那种：PC 一排图标，移动端收一部分）
 * 2. **点开就地展开面板**（不跳页）：面板内容 = `web/<component>.js` 的 `mount(el, host)`
 * 3. **角标**：注册时给了 `badge.endpoint`，宿主定期拉 `{ count }` 显示在图标上
 *
 * 面板是**单实例**的：同时只开一个，再点同一个就关。
 */

import { onBeforeUnmount, onMounted, ref, shallowRef, type ShallowRef } from 'vue';
import type { RegistryHeaderActionDTO } from '@pi-agent-platform/api-types';
import { createPluginHost, importPluginModule, loadGlobalExtensions } from './host';

/** 顶栏一次性拉到的动作清单（响应式：插件启停后 `refresh()` 即可）。 */
const actions: ShallowRef<RegistryHeaderActionDTO[]> = shallowRef([]);
/** 角标计数：`<pluginId>:<actionId>` → count。 */
const badges = shallowRef<Record<string, number>>({});

export const headerActions = actions;
export const headerBadges = badges;

const BADGE_POLL_MS = 60_000;

function badgeKey(pluginId: string, actionId: string): string {
  return `${pluginId}:${actionId}`;
}

/** 拉一次动作清单并刷新角标。 */
export async function refreshHeaderActions(): Promise<void> {
  try {
    const body = await loadGlobalExtensions(true);
    actions.value = body.disabledByFlag ? [] : (body.headerActions ?? []);
  } catch (err) {
    console.warn('[plugin] refresh header actions failed', err);
    actions.value = [];
  }
  await refreshBadges();
}

/** 拉一轮角标（只问声明了 `badge.endpoint` 的动作）。 */
export async function refreshBadges(): Promise<void> {
  const next: Record<string, number> = {};
  await Promise.allSettled(
    actions.value
      .filter((a) => a.badge?.endpoint)
      .map(async (a) => {
        const url = `/api/p/${encodeURIComponent(a.pluginId)}${a.badge!.endpoint}`;
        const res = await fetch(url);
        if (!res.ok) return;
        const body = (await res.json()) as { count?: unknown };
        const count = typeof body.count === 'number' ? body.count : 0;
        if (count > 0) next[badgeKey(a.pluginId, a.id)] = count;
      }),
  );
  badges.value = next;
}

// ---------- 面板（单实例） ----------

interface OpenPanel {
  key: string;
  el: HTMLElement;
  dispose: () => void;
}

const openPanel: ShallowRef<OpenPanel | null> = shallowRef(null);

/** 当前打开的面板 key（`<pluginId>:<actionId>`），没有则 null。 */
export const activePanelKey = openPanel;

async function closePanel(): Promise<void> {
  const current = openPanel.value;
  if (!current) return;
  openPanel.value = null;
  try {
    current.dispose();
  } catch (err) {
    console.warn('[plugin] header panel dispose failed', err);
  }
  current.el.remove();
  await refreshBadges();
}

/** 打开/切换某个动作的面板；`anchor` 是面板要挂靠的位置（顶栏容器）。 */
export async function toggleHeaderPanel(
  action: RegistryHeaderActionDTO,
  anchor: HTMLElement,
): Promise<void> {
  const key = badgeKey(action.pluginId, action.id);
  if (openPanel.value?.key === key) {
    await closePanel();
    return;
  }
  await closePanel();

  const el = document.createElement('div');
  el.className = 'plugin-header-panel';
  anchor.appendChild(el);

  let dispose = (): void => {};
  try {
    const mod = await importPluginModule(action.pluginId, action.component);
    const cleanup = mod.mount(
      el,
      createPluginHost({ pluginId: action.pluginId }),
    );
    dispose = () => {
      if (typeof cleanup === 'function') cleanup();
    };
    openPanel.value = { key, el, dispose };
  } catch (err) {
    el.textContent = `插件 ${action.pluginId} 加载失败`;
    el.classList.add('plugin-header-panel--error');
    console.error('[plugin] header panel mount failed', action.pluginId, err);
    openPanel.value = { key, el, dispose };
  }
}

/** 面板外层点击 / Esc 关闭（在组件里挂一次即可）。 */
export function installPanelDismiss(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') void closePanel();
  };
  const onClick = (e: MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    // 点面板内部或动作按钮本身不关（按钮自己 toggle）
    if (target.closest('.plugin-header-panel') || target.closest('[data-header-action]')) return;
    void closePanel();
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('mousedown', onClick);
  return () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('mousedown', onClick);
  };
}

/** 组件里用的组合式封装：挂载时拉清单 + 起角标轮询，卸载时清干净。 */
export function useHeaderActions(): {
  actions: ShallowRef<RegistryHeaderActionDTO[]>;
  badges: ShallowRef<Record<string, number>>;
  activeKey: ShallowRef<OpenPanel | null>;
  toggle: typeof toggleHeaderPanel;
  badgeOf: (action: RegistryHeaderActionDTO) => number;
} {
  let timer: number | undefined;
  let uninstall: (() => void) | undefined;

  onMounted(() => {
    void refreshHeaderActions();
    timer = window.setInterval(() => void refreshBadges(), BADGE_POLL_MS);
    uninstall = installPanelDismiss();
  });
  onBeforeUnmount(() => {
    if (timer) window.clearInterval(timer);
    uninstall?.();
    void closePanel();
  });

  return {
    actions,
    badges,
    activeKey: openPanel,
    toggle: toggleHeaderPanel,
    badgeOf: (action) => badges.value[badgeKey(action.pluginId, action.id)] ?? 0,
  };
}

export const __test = { badgeKey, closePanel };
