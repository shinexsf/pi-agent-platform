<script setup lang="ts">
/**
 * ChannelsView — IM 渠道管理容器。
 *
 * 渠道选择的位置（design.md D1/D2）：
 *   - 抽屉（`AppDrawer` 的二级菜单）—— 所有断点，桌面展开时即「左侧栏」
 *   - 顶部分段控件 —— 仅紧凑断点（<768px）
 *
 * 渠道由路由参数驱动（`/im/:channelType?`），可深链、刷新不丢。
 * 渠道清单走共享的 `useChannelList()`（与抽屉同一份数据、单次请求）。
 */
import { computed, markRaw, shallowRef, watch, defineAsyncComponent, type Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useChannelList } from '../../modules/im-gateway/useChannelList';
import type { ChannelAdminPage } from '../../modules/im-gateway';
import AppIcon from '../../components/ui/AppIcon.vue';
import { useIsCompact } from '../../composables/useMediaQuery';

const route = useRoute();
const router = useRouter();
const isCompact = useIsCompact();
const { channels, ready } = useChannelList();

const selectedChannelType = computed(() => {
  const raw = route.params.channelType;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : '';
});

/** 路由未指定渠道时，回退到列表首项（manifest 决定了清单顺序）。 */
const effectiveChannelType = computed(
  () => selectedChannelType.value || channels.value[0]?.channelType || '',
);

const componentByType = new Map<string, Component>();
const contentComponent = shallowRef<Component | null>(null);

function resolveComponent(channelType: string): Component | null {
  if (!channelType) return null;
  const cached = componentByType.get(channelType);
  if (cached) return cached;
  const page = channels.value.find((channel) => channel.channelType === channelType);
  if (!page) return null;
  const async = markRaw(defineAsyncComponent(page.component as ChannelAdminPage['component'])) as Component;
  componentByType.set(channelType, async);
  return async;
}

watch(
  effectiveChannelType,
  (channelType) => {
    // 供 apiFetch 解析渠道前缀（沿用 window.__channelAdminHost 契约）
    (window as unknown as { __currentChannelType?: string }).__currentChannelType = channelType || undefined;
    contentComponent.value = resolveComponent(channelType);
  },
  { immediate: true },
);

// 渠道清单异步就绪后重新解析组件（路由已带 channelType 时，effectiveChannelType 不变，
// 但 channels 从空变为就绪，需要重试一次性解析）
watch(ready, (isReady) => {
  if (!isReady) return;
  contentComponent.value = resolveComponent(effectiveChannelType.value);
});

function selectChannel(channel: ChannelAdminPage): void {
  if (channel.channelType === effectiveChannelType.value) return;
  void router.push(`/im/${channel.channelType}`);
}

function iconName(channelType: string): string {
  if (channelType === 'wechat') return 'wechat';
  if (channelType === 'qq') return 'qq';
  return 'im';
}
</script>

<template>
  <div class="channels-view">
    <div v-if="isCompact" class="channels-segmented" role="tablist" aria-label="IM 渠道">
      <button
        v-for="channel in channels"
        :key="channel.channelType"
        type="button"
        role="tab"
        class="channel-chip"
        :class="{ 'is-active': effectiveChannelType === channel.channelType }"
        :aria-selected="effectiveChannelType === channel.channelType"
        @click="selectChannel(channel)"
      >
        <AppIcon :name="iconName(channel.channelType)" :size="16" />
        <span>{{ channel.displayName }}</span>
      </button>
    </div>

    <div v-if="!ready" class="channels-state">加载中...</div>
    <div v-else-if="channels.length === 0" class="channels-state">暂无渠道</div>

    <main class="channels-content">
      <component :is="contentComponent" v-if="contentComponent" />
      <div v-else class="channels-state channels-state--center">选择一个渠道查看配置</div>
    </main>
  </div>
</template>

<style scoped>
.channels-view {
  display: flex;
  flex-direction: column;
  max-width: 1240px;
  margin: 0 auto;
  width: 100%;
  background: var(--bg);
}

/* 紧凑断点：顶部分段控件 */
.channels-segmented {
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

.channels-segmented::-webkit-scrollbar {
  display: none;
}

.channel-chip {
  display: inline-flex;
  min-height: 32px;
  flex: none;
  align-items: center;
  gap: 7px;
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

.channel-chip:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.channel-chip.is-active {
  border-color: transparent;
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.channels-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 12px;
}

.channels-state {
  padding: 20px;
  color: var(--text-secondary);
  font-size: 0.85rem;
  text-align: center;
}

.channels-state--center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

@media (max-width: 767px) {
  .channels-content {
    padding: 10px;
  }
}
</style>
