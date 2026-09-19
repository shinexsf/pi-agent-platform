/**
 * useMediaQuery — reactive `window.matchMedia` wrapper.
 *
 * 为什么需要它：响应式布局必须做**条件渲染**而不是 CSS `display:none` 隐藏栏位，
 * 否则会出现双滚动容器 / 双 textarea 焦点 / 屏幕阅读器重复播报。
 *
 * 首帧行为：`matchMedia(...).matches` 是同步的，所以初始值就是正确的，
 * 不会出现「先渲染桌面版再跳到移动版」的布局跳动。
 */
import { onBeforeUnmount, ref, type Ref } from 'vue';

/** 布局断点契约（见 openspec/changes/responsive-web-layout/design.md D4）。 */
export const BP = {
  /** 紧凑：抽屉为覆盖层，内容单栏，section 切换用顶部分段控件 */
  compact: '(max-width: 767px)',
  /** 中等：表单可两列，抽屉仍为覆盖层 */
  medium: '(min-width: 768px) and (max-width: 1023px)',
  /** 桌面：抽屉为常驻侧栏，内容可两栏 */
  desktop: '(min-width: 1024px)',
} as const;

/** 供 `useMediaQuery` 之外的命令式场景使用（如条件挂载前的判断）。 */
export function matchesQuery(query: string): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): Ref<boolean> {
  const mql = typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia(query)
    : null;

  const matches = ref(mql ? mql.matches : false);

  if (mql) {
    const onChange = (event: MediaQueryListEvent) => {
      matches.value = event.matches;
    };
    // addEventListener 在 Safari < 14 不支持，但本项目 target 为现代浏览器；
    // 保留 addListener fallback 以避免老 JCEF 内核异常。
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      onBeforeUnmount(() => mql.removeEventListener('change', onChange));
    } else {
      const legacy = mql as MediaQueryList & {
        addListener?: (cb: (e: MediaQueryListEvent) => void) => void;
        removeListener?: (cb: (e: MediaQueryListEvent) => void) => void;
      };
      legacy.addListener?.(onChange);
      onBeforeUnmount(() => legacy.removeListener?.(onChange));
    }
  }

  return matches;
}

/** 紧凑断点（< 768px）。 */
export function useIsCompact(): Ref<boolean> {
  return useMediaQuery(BP.compact);
}

/** 桌面断点（>= 1024px）。 */
export function useIsDesktop(): Ref<boolean> {
  return useMediaQuery(BP.desktop);
}
