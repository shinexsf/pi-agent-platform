<script setup lang="ts">
/**
 * SplitPane — 列表 / 详情两栏原语。
 *
 * - 桌面（≥768px）：左右两栏同时展示
 * - 紧凑（<768px）：单栏；`detailOpen` 时详情占满，顶部出现返回条
 *
 * 隐藏栏位用 `v-show`（`display:none`）而非仅靠透明度：`display:none` 的元素
 * 不产生滚动盒、不可聚焦，因此不会出现「双滚动容器 / 双 textarea 可聚焦」
 * 的问题（spec app-layout「条件渲染而非 CSS 隐藏」）。列表状态得以保留。
 */
import { useIsCompact } from '../../../composables/useMediaQuery';
import AppIcon from '../../ui/AppIcon.vue';

defineProps<{
  /** 紧凑断点下是否展示详情栏；桌面恒为两栏 */
  detailOpen: boolean;
  /** 紧凑断点下返回条的文案（通常是列表名） */
  backLabel: string;
}>();

const emit = defineEmits<{ (event: 'back'): void }>();

const isCompact = useIsCompact();
</script>

<template>
  <div class="split-pane">
    <div v-show="!isCompact || !detailOpen" class="split-pane__list">
      <slot name="list" />
    </div>

    <div v-show="!isCompact || detailOpen" class="split-pane__detail">
      <button
        v-if="isCompact && detailOpen"
        type="button"
        class="split-pane__back"
        @click="emit('back')"
      >
        <AppIcon name="arrow-left" :size="16" />
        <span>{{ backLabel }}</span>
      </button>
      <slot name="detail" />
    </div>
  </div>
</template>

<style scoped>
.split-pane {
  display: flex;
  flex: 1;
  min-height: 0;
  gap: 16px;
}

.split-pane__list {
  display: flex;
  width: 240px;
  flex: none;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}

.split-pane__detail {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}

.split-pane__back {
  display: flex;
  min-height: 44px;
  flex: none;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.84rem;
  font-weight: 650;
  cursor: pointer;
}

.split-pane__back:hover {
  background: var(--surface-hover);
  color: var(--text);
}

@media (max-width: 767px) {
  .split-pane {
    flex-direction: column;
    gap: 0;
  }

  /* 列表栏不再使用固定像素宽度（spec：固定宽度列表栏） */
  .split-pane__list,
  .split-pane__detail {
    width: auto;
    flex: 1;
    border-radius: 10px;
  }
}
</style>
