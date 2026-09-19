<script setup lang="ts">
/**
 * ConfigView — 配置模块外壳。
 *
 * 只做两件事：
 *   1. 紧凑断点渲染顶部分段控件（避免为切换 section 而打开遮罩抽屉）
 *   2. 用 `<router-view>` 渲染子路由（各 section / 编辑器路由页）
 *
 * section 导航本体在抽屉（`AppDrawer` 的二级菜单）——桌面展开抽屉时即「左侧栏」，
 * 视图内不再保留自己的侧栏（design.md D10）。
 */
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { CONFIG_SECTIONS, configSectionFromPath } from './sections';
import { useIsCompact } from '../../composables/useMediaQuery';

const route = useRoute();
const router = useRouter();
const isCompact = useIsCompact();

const activeSection = computed(() => configSectionFromPath(route.path));

function selectSection(id: string): void {
  if (id === activeSection.value) return;
  void router.push(`/config/${id}`);
}
</script>

<template>
  <div class="config-view">
    <div v-if="isCompact" class="config-segmented" role="tablist" aria-label="配置分区">
      <button
        v-for="section in CONFIG_SECTIONS"
        :key="section.id"
        type="button"
        role="tab"
        class="config-chip"
        :class="{ 'is-active': activeSection === section.id }"
        :aria-selected="activeSection === section.id"
        @click="selectSection(section.id)"
      >
        <span class="config-chip-icon" aria-hidden="true">{{ section.icon }}</span>
        <span>{{ section.label }}</span>
      </button>
    </div>

    <main class="config-content">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.config-view {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  background: var(--bg);
}

/* 紧凑断点：顶部分段控件（横向可滚动，项数超出时仍可访问全部） */
.config-segmented {
  display: flex;
  flex: none;
  gap: 8px;
  padding: 12px 16px;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  scrollbar-width: none;
}

.config-segmented::-webkit-scrollbar {
  display: none;
}

.config-chip {
  display: inline-flex;
  min-height: 32px;
  flex: none;
  align-items: center;
  gap: 5px;
  padding: 6px 11px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-subtle);
  color: var(--text-secondary);
  font-size: 0.76rem;
  font-weight: 650;
  white-space: nowrap;
  cursor: pointer;
  transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease;
}

.config-chip:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.config-chip.is-active {
  border-color: transparent;
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.config-chip-icon {
  font-size: 0.95rem;
}

.config-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 16px 12px;
}

@media (max-width: 767px) {
  .config-content {
    padding: 10px 10px;
  }
}
</style>
