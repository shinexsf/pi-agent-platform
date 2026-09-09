<script setup lang="ts">
/**
 * ConfigView — 配置管理主页面（master-detail 布局）
 *
 * 左侧：功能列表
 * 右侧：对应功能的内容区
 */
import { ref, computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import ModelsConfig from './ModelsConfig.vue';
import SkillsConfig from './SkillsConfig.vue';
import PromptsConfig from './PromptsConfig.vue';
import ExtensionsConfig from './ExtensionsConfig.vue';
import DefaultSettings from './DefaultSettings.vue';
import AppIcon from '../../components/ui/AppIcon.vue';

const route = useRoute();
const router = useRouter();

interface ConfigMenuItem {
  id: string;
  label: string;
  icon: string;
}

const menuItems: ConfigMenuItem[] = [
  { id: 'models', label: '模型 API', icon: '🔧' },
  { id: 'settings', label: '默认设置', icon: '⚙️' },
  { id: 'skills', label: 'Skills', icon: '📚' },
  { id: 'prompts', label: 'Prompts', icon: '💬' },
  { id: 'extensions', label: '插件管理', icon: '🧩' },
];

const activeTab = ref('models');
const sidebarCollapsed = ref(false);

const activeComponent = computed(() => {
  switch (activeTab.value) {
    case 'models': return ModelsConfig;
    case 'settings': return DefaultSettings;
    case 'skills': return SkillsConfig;
    case 'prompts': return PromptsConfig;
    case 'extensions': return ExtensionsConfig;
    default: return ModelsConfig;
  }
});

function selectTab(id: string) {
  activeTab.value = id;
}
</script>

<template>
  <div class="config-view">
    <aside class="config-sidebar" :class="{ collapsed: sidebarCollapsed }">
      <div class="sidebar-header">
        <h2 v-if="!sidebarCollapsed" class="config-sidebar-title">配置管理</h2>
        <button class="collapse-btn" @click="sidebarCollapsed = !sidebarCollapsed" :title="sidebarCollapsed ? '展开' : '折叠'">
          <AppIcon :name="sidebarCollapsed ? 'chevron-right' : 'chevron-left'" :size="16" />
        </button>
      </div>
      <nav class="config-menu">
        <button
          v-for="item in menuItems"
          :key="item.id"
          :class="['config-menu-item', { active: activeTab === item.id }]"
          @click="selectTab(item.id)"
        >
          <span class="config-menu-icon" :title="item.label">{{ item.icon }}</span>
          <span v-if="!sidebarCollapsed" class="config-menu-label">{{ item.label }}</span>
        </button>
      </nav>
    </aside>
    <main class="config-content">
      <component :is="activeComponent" />
    </main>
  </div>
</template>

<style scoped>
.config-view {
  display: flex;
  height: calc(100vh - 60px);
  background: var(--bg);
}

.config-sidebar {
  width: 200px;
  border-right: 1px solid var(--border);
  padding: 16px;
  flex-shrink: 0;
  transition: width 200ms ease;
}

.config-sidebar.collapsed {
  width: 60px;
  padding: 16px 8px;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.config-sidebar.collapsed .sidebar-header {
  justify-content: center;
  margin-bottom: 12px;
}

.collapse-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
}

.collapse-btn:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.config-sidebar.collapsed .config-menu {
  align-items: center;
}

.config-sidebar-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.config-menu {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.config-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.9rem;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  transition: all 150ms ease;
  width: 100%;
}

.config-sidebar.collapsed .config-menu-item {
  padding: 12px;
  justify-content: center;
}

.config-menu-item:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.config-menu-item.active {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.config-menu-icon {
  font-size: 1rem;
}

.config-menu-label {
  flex: 1;
}

.config-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 24px;
}
</style>
