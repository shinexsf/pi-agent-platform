<script setup lang="ts">
/**
 * AppDrawer — 一级 + 二级导航抽屉。
 *
 * 两态（design.md D2，默认完全收起，无图标栏）：
 *   - ≥ 1024px：常驻侧栏（flex 子项，挤压内容，无遮罩）
 *   - <  1024px：覆盖层（fixed + 遮罩，Esc / 点遮罩 / 选中菜单后关闭）
 *
 * 二级菜单（D3）：平铺，全部展开。
 */
import { computed, onBeforeUnmount, watch } from 'vue';
import { useRoute } from 'vue-router';
import AppIcon from '../ui/AppIcon.vue';
import { useNavTree, type NavNode, isWithin } from './nav-tree';
import { useIsCompact, useIsDesktop } from '../../composables/useMediaQuery';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (event: 'update:open', value: boolean): void;
}>();

const route = useRoute();
const { nodes } = useNavTree();
const isDesktop = useIsDesktop();
const isCompact = useIsCompact();


const visibleNodes = computed<NavNode[]>(() =>
  isCompact.value ? nodes.value.filter((node) => !node.mobileHidden) : nodes.value,
);

function childrenOf(node: NavNode): NavNode['children'] {
  return node.children;
}



function isNodeActive(node: NavNode): boolean {
  return isWithin(route.path, node.path);
}

function isLeafActive(leafPath: string): boolean {
  return route.path === leafPath || route.path.startsWith(`${leafPath}/`);
}

function close(): void {
  // 桌面端抽屉常驻，不关闭
  if (isDesktop.value) return;
  emit('update:open', false);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') close();
}

/** 覆盖层模式下锁定背景滚动（背景仍可见，但不跟随滚动）。 */
function applyScrollLock(locked: boolean): void {
  if (typeof document === 'undefined') return;
  document.body.style.overflow = locked ? 'hidden' : '';
}

watch(
  () => props.open,
  (open) => {
    const overlay = open && !isDesktop.value;
    applyScrollLock(overlay);
    if (open && !isDesktop.value) {
      window.addEventListener('keydown', onKeydown);
    } else {
      window.removeEventListener('keydown', onKeydown);
    }
  },
);

// 断点跨越时：桌面 ↔ 紧凑切换可能导致遮罩/滚动锁状态不一致
watch(isDesktop, () => {
  const overlay = props.open && !isDesktop.value;
  applyScrollLock(overlay);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  applyScrollLock(false);
});
</script>

<template>
  <div v-if="open && !isDesktop" class="app-drawer-backdrop" @click="close" aria-hidden="true" />

  <Transition name="drawer">
    <aside
      v-if="open"
      class="app-drawer"
      :class="{ 'is-overlay': !isDesktop }"
      aria-label="主导航"
    >
      <nav class="drawer-nav">
        <template v-for="node in visibleNodes" :key="node.path">
          <router-link
            class="drawer-item drawer-item--top"
            :class="{ 'is-active': isNodeActive(node) }"
            :to="node.path"
            :aria-current="isNodeActive(node) ? 'page' : undefined"
            :style="isNodeActive(node) ? { viewTransitionName: 'nav-active' } : undefined"
            @click="close"
          >
            <AppIcon :name="node.icon ?? 'agents'" :size="17" />
            <span class="drawer-item-label">{{ node.label }}</span>
          </router-link>

          <template v-if="node.children.length > 0">
            <router-link
              v-for="leaf in childrenOf(node)"
              :key="leaf.path"
              class="drawer-item drawer-item--leaf"
              :class="{ 'is-active': isLeafActive(leaf.path) }"
              :to="leaf.path"
              :aria-current="isLeafActive(leaf.path) ? 'page' : undefined"
              @click="close"
            >
              <span class="drawer-item-label">{{ leaf.label }}</span>
            </router-link>
          </template>
        </template>
      </nav>
    </aside>
  </Transition>
</template>

<style scoped>
.app-drawer-backdrop {
  position: fixed;
  top: var(--app-header-h);
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 190;
  background: color-mix(in srgb, #0b1220 46%, transparent);
  backdrop-filter: blur(2px);
}

.app-drawer {
  position: sticky;
  top: var(--app-header-h);
  display: flex;
  width: 232px;
  height: calc(100dvh - var(--app-header-h));
  flex: none;
  flex-direction: column;
  padding: 12px 10px calc(20px + env(safe-area-inset-bottom));
  overflow-y: auto;
  overscroll-behavior: contain;
  border-right: 1px solid var(--border);
  background: var(--surface);
}

.app-drawer.is-overlay {
  position: fixed;
  top: var(--app-header-h);
  bottom: 0;
  left: 0;
  z-index: 200;
  width: min(84vw, 300px);
  height: auto;
  box-shadow: 0 30px 72px -34px rgba(0, 0, 0, 0.6);
}

.drawer-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.drawer-item {
  display: flex;
  min-height: 36px;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 0.82rem;
  font-weight: 650;
  text-decoration: none;
  transition: background-color 150ms ease, color 150ms ease;
}

.drawer-item:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.drawer-item.is-active {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

/* 二级项：缩进 + 轻字重，不做图标，避免与一级项视觉混淆 */
.drawer-item--leaf {
  min-height: 32px;
  margin-left: 22px;
  padding: 6px 12px;
  font-size: 0.78rem;
  font-weight: 550;
}

.drawer-item-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}


.drawer-enter-active,
.drawer-leave-active {
  transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1), opacity 180ms ease;
}

.app-drawer.is-overlay.drawer-enter-from,
.app-drawer.is-overlay.drawer-leave-to {
  transform: translateX(-100%);
  opacity: 0;
}
</style>
