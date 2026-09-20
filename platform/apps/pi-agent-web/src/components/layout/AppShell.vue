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
import { ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useTheme } from '../../composables/useTheme';
import { useIsCompact, useIsDesktop, BP } from '../../composables/useMediaQuery';
import AppIcon from '../ui/AppIcon.vue';
import AppBreadcrumb from './AppBreadcrumb.vue';
import AppDrawer from './AppDrawer.vue';
import ToastHost from '../../modules/im-gateway/components/ToastHost.vue';
import ConfirmDialogHost from '../../modules/im-gateway/components/ConfirmDialogHost.vue';

const DRAWER_STORAGE_KEY = 'pi-web-drawer-open';

const { theme, toggle } = useTheme();
const route = useRoute();
const isDesktop = useIsDesktop();
const isCompact = useIsCompact();

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
  },
);
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

        <div class="header-actions">
          <router-link
            v-if="!isCompact"
            class="header-icon-btn"
            to="/architecture"
            title="架构图"
            aria-label="架构图"
          >
            <AppIcon name="architecture" :size="18" />
          </router-link>
          <button
            class="theme-toggle"
            type="button"
            :aria-label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
            @click="toggle"
          >
            <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" :size="18" />
          </button>
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
</style>
