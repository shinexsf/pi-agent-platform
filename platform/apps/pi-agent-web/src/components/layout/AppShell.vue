<script setup lang="ts">
/**
 * AppShell — 顶层外壳。
 *
 * 结构（design.md D1/D2/D7）：
 *   header: [汉堡] [品牌] [面包屑] ……… [架构图] [主题]
 *   body:   [抽屉（可收起，默认收起）] [main]
 *
 * 抽屉行为由 AppDrawer 内部按断点决定——≥1024px 为常驻侧栏（挤压内容），
 * <1024px 为带遮罩的覆盖层。本组件只负责持有 open 状态。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useTheme } from '../../composables/useTheme';
import { useIsCompact, useIsDesktop, BP } from '../../composables/useMediaQuery';
import AppIcon from '../ui/AppIcon.vue';
import AppBreadcrumb from './AppBreadcrumb.vue';
import AppDrawer from './AppDrawer.vue';
import ToastHost from '../feedback/ToastHost.vue';
import ConfirmDialogHost from '../feedback/ConfirmDialogHost.vue';
import { closeHeaderPanel, useHeaderActions } from '../../plugins/headerActions';

const DRAWER_STORAGE_KEY = 'pi-web-drawer-open';

const { theme, toggle } = useTheme();
const route = useRoute();
const isDesktop = useIsDesktop();
const isCompact = useIsCompact();

/**
 * 顶栏图标区 = 平台动作（架构图 / 主题）+ 插件动作（R11）。
 *
 * 折叠规则（GitHub 右上角那种）：桌面全平铺；紧凑端只留 `INLINE_ON_COMPACT` 个插件动作，
 * 其余进「更多」菜单；平台的架构图在紧凑端没有独立按钮，一并收进「更多」（折叠不能丢入口）。
 * 主题切换始终常驻 —— 它是全站开关，藏进二级菜单没人找得到。
 */
const INLINE_ON_COMPACT = 1;
const { actions: headerActionItems, toggle: toggleHeaderAction, activeKey, badgeOf } = useHeaderActions();
const moreOpen = ref(false);
const headerRef = ref<HTMLElement | null>(null);

const compactInline = computed(() => headerActionItems.value.slice(0, INLINE_ON_COMPACT));
const compactOverflow = computed(() => headerActionItems.value.slice(INLINE_ON_COMPACT));

async function onHeaderAction(action: (typeof headerActionItems.value)[number]): Promise<void> {
  moreOpen.value = false;
  const anchor = headerRef.value;
  if (!anchor) return;
  await toggleHeaderAction(action, anchor);
}

function readInitialDrawerState(): boolean {
  try {
    const stored = localStorage.getItem(DRAWER_STORAGE_KEY);
    if (stored !== null) return stored === '1';
    // 首次访问：桌面端默认展开，移动端默认收起
    return window.matchMedia(`(min-width: ${BP.desktop + 1}px)`).matches;
  } catch {
    return false;
  }
}

/** 抽屉默认完全收起（design.md D2）。 */
const drawerOpen = ref(readInitialDrawerState());

watch(drawerOpen, (open) => {
  try {
    localStorage.setItem(DRAWER_STORAGE_KEY, open ? '1' : '0');
  } catch {
    /* localStorage 不可用时忽略（隐私模式） */
  }
});

// 紧凑断点下选中菜单后自动关闭抽屉（路由变化即视为已选中）
watch(
  () => route.fullPath,
  () => {
    if (!isDesktop.value) drawerOpen.value = false;
    moreOpen.value = false;
    // 顶栏面板是"就地展开"的浮层：站内跳转（例如通知面板的「查看全部」
    // → /notifications、架构图面板选一张 → /architecture）后它不该继续盖着新页面。
    void closeHeaderPanel();
  },
);

onMounted(() => {
  // 顶栏角标由 useHeaderActions 自己拉（60s 轮询 + 面板关闭后刷新）
});
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell--full-width': route.meta.fullWidth === true }">
    <header class="app-header">
      <div class="app-header-inner">
        <button
          class="header-icon-btn"
          type="button"
          :aria-label="drawerOpen ? '收起导航' : '展开导航'"
          :aria-expanded="drawerOpen"
          aria-controls="app-drawer"
          @click="drawerOpen = !drawerOpen"
        >
          <AppIcon :name="drawerOpen && !isDesktop ? 'close' : 'menu'" :size="19" />
        </button>

        <AppBreadcrumb />

        <div ref="headerRef" class="header-actions">
          <!-- 插件顶栏动作（R11）：桌面平铺，紧凑端收起一部分 -->
          <template v-for="action in isCompact ? compactInline : headerActionItems" :key="`${action.pluginId}:${action.id}`">
            <button
              class="header-icon-btn"
              type="button"
              data-header-action
              :title="action.title"
              :aria-label="action.title"
              :aria-expanded="activeKey?.key === `${action.pluginId}:${action.id}`"
              @click="onHeaderAction(action)"
            >
              <AppIcon :name="action.icon" :size="18" />
              <span v-if="badgeOf(action) > 0" class="notification-badge">
                {{ badgeOf(action) > 99 ? '99+' : badgeOf(action) }}
              </span>
            </button>
          </template>

          <button
            v-if="isCompact"
            class="header-icon-btn"
            type="button"
            title="更多"
            aria-label="更多"
            :aria-expanded="moreOpen"
            @click="moreOpen = !moreOpen"
          >
            <AppIcon name="more" :size="18" />
          </button>

          <button
            class="theme-toggle"
            type="button"
            :aria-label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
            @click="toggle"
          >
            <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" :size="18" />
          </button>

          <!-- 紧凑端的「更多」菜单：收纳溢出的插件动作 + 平台动作（架构图）-->
          <div v-if="isCompact && moreOpen" class="header-more">
            <button
              v-for="action in compactOverflow"
              :key="`more:${action.pluginId}:${action.id}`"
              class="header-more-item"
              type="button"
              @click="onHeaderAction(action)"
            >
              <AppIcon :name="action.icon" :size="16" />
              <span>{{ action.title }}</span>
              <span v-if="badgeOf(action) > 0" class="header-more-badge">{{ badgeOf(action) }}</span>
            </button>
          </div>
        </div>
      </div>
    </header>

    <div class="app-body">
      <AppDrawer :open="drawerOpen" @update:open="drawerOpen = $event" />
      <main id="main-content" class="app-main" tabindex="-1">
        <slot />
      </main>
    </div>

    <ToastHost />
    <ConfirmDialogHost />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  min-height: 100dvh;
  flex-direction: column;
}

.app-shell--full-width {
  height: 100dvh;
  min-height: 0;
  overflow: hidden;
}

.app-header {
  flex: none;
}

.app-body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.app-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.app-shell--full-width .app-header {
  flex: none;
}

.app-shell--full-width .app-main {
  flex: 1;
  width: 100%;
  max-width: none;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  animation: none;
}

.header-icon-btn {
  display: inline-flex;
  width: 40px;
  height: 40px;
  flex: none;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 11px;
  background: var(--surface-subtle);
  color: var(--text-secondary);
  cursor: pointer;
  text-decoration: none;
  transition: background-color 160ms ease, border-color 160ms ease, color 160ms ease;
}

.header-icon-btn:hover {
  border-color: var(--border-strong);
  background: var(--surface-hover);
  color: var(--text);
}

.header-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

/*
 * 顶栏角标（R11 插件动作与平台动作共用）。
 *
 * 挂在 `.header-icon-btn` 上就对了 —— 曾经靠 `.notification-bell` 单独给
 * `position: relative`，插件动作没有那个 class，绝对定位就落到 `.header-actions`
 * 上，角标跑到最右边那个按钮（主题切换）头上。
 */
.header-icon-btn {
  position: relative;
}

.notification-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  z-index: 1;
  min-width: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: #dc2626;
  color: #fff;
  font-size: 0.62rem;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  line-height: 16px;
  text-align: center;
}

/* 紧凑断点：按钮缩小但保持可点 */
@media (max-width: 767px) {
  .header-icon-btn,
  .theme-toggle {
    width: 32px;
    min-width: 32px;
    height: 32px;
    border-radius: 8px;
  }
}

/* 顶栏插件面板：挂在 header 里，绝对定位展开（不推内容） */
.header-actions {
  position: relative;
}

.header-more {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 168px;
  padding: 6px;
  border-radius: 10px;
  border: 1px solid var(--border, #e5e7eb);
  background: var(--surface, #fff);
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.12);
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 60;
}

.header-more-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  border-radius: 7px;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.header-more-item:hover {
  background: var(--surface-alt, #f3f4f6);
}

.header-more-badge {
  margin-left: auto;
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--danger-bg, #fee2e2);
  color: var(--danger, #b91c1c);
}

/* 插件面板（内容由插件 mount，宿主只给外壳与定位） */
:deep(.plugin-header-panel) {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: min(420px, calc(100vw - 24px));
  max-height: min(70vh, 560px);
  overflow: auto;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--border, #e5e7eb);
  background: var(--surface, #fff);
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.14);
  z-index: 70;
}

:deep(.plugin-header-panel--error) {
  color: var(--danger, #b91c1c);
  font-size: 13px;
}
</style>
