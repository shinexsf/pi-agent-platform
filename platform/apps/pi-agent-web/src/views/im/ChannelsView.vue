<script setup lang="ts">
/**
 * ChannelsView — IM 渠道管理主页面（master-detail 布局）
 *
 * 左侧：渠道卡片列表（从 channelAdminRegistry 读取）
 * 右侧：选中渠道的页面组件
 */
import { ref, computed, onMounted, shallowRef, markRaw, defineAsyncComponent } from 'vue';
import { channelAdminRegistry, loadChannelManifest } from '../../modules/im-gateway';
import type { ChannelAdminPage } from '../../modules/im-gateway';
import AppIcon from '../../components/ui/AppIcon.vue';

const channels = ref<ChannelAdminPage[]>([]);
const selectedChannelType = ref<string>('');
const loading = ref(true);
const contentComponent = shallowRef<ReturnType<typeof markRaw> | null>(null);

onMounted(async () => {
  try {
    channels.value = await loadChannelManifest();
    // 如果 manifest 返回空，使用 registry 作为 fallback
    if (channels.value.length === 0) {
      channels.value = channelAdminRegistry;
    }
    // 默认选中第一个
    if (channels.value.length > 0 && channels.value[0]) {
      selectChannel(channels.value[0]);
    }
  } catch (err) {
    console.error('Failed to load channels:', err);
    channels.value = channelAdminRegistry;
    if (channels.value.length > 0 && channels.value[0]) {
      selectChannel(channels.value[0]);
    }
  } finally {
    loading.value = false;
  }
});

function selectChannel(channel: ChannelAdminPage) {
  selectedChannelType.value = channel.channelType;
  // 设置全局 channelType，供 apiFetch 使用
  (window as any).__currentChannelType = channel.channelType;
  // 使用 defineAsyncComponent 包装异步组件
  contentComponent.value = markRaw(defineAsyncComponent(channel.component));
}

function getChannelIcon(channelType: string): string {
  // 映射渠道类型到图标
  const iconMap: Record<string, string> = {
    wechat: 'wechat',
    qq: 'qq',
  };
  return iconMap[channelType] || 'im';
}
</script>

<template>
  <div class="channels-view">
    <aside class="channels-sidebar">
      <h2 class="channels-sidebar-title">IM</h2>
      <div v-if="loading" class="loading">加载中...</div>
      <div v-else-if="channels.length === 0" class="empty-state">暂无渠道</div>
      <nav v-else class="channels-list">
        <button
          v-for="channel in channels"
          :key="channel.channelType"
          :class="['channel-card', { active: selectedChannelType === channel.channelType }]"
          @click="selectChannel(channel)"
        >
          <AppIcon :name="getChannelIcon(channel.channelType)" :size="24" />
          <span class="channel-name">{{ channel.displayName }}</span>
        </button>
      </nav>
    </aside>
    <main class="channels-content">
      <component :is="contentComponent" v-if="contentComponent" />
      <div v-else class="empty-content">
        选择一个渠道查看配置
      </div>
    </main>
  </div>
</template>

<style scoped>
.channels-view {
  display: flex;
  height: calc(100vh - 60px);
  background: var(--bg);
}

.channels-sidebar {
  width: 200px;
  border-right: 1px solid var(--border);
  padding: 16px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
}

.channels-sidebar-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}

.channels-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.channel-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.9rem;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  transition: all 150ms ease;
}

.channel-card:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.channel-card.active {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.channel-name {
  flex: 1;
  font-weight: 500;
}

.channels-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 24px;
}

.empty-content {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.loading, .empty-state {
  color: var(--text-secondary);
  font-size: 0.85rem;
  text-align: center;
  padding: 20px;
}
</style>
