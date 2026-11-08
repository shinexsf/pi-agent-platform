<script setup lang="ts">
/**
 * 架构图页：两级切换器（集合 → 图）+ iframe 承载 archify 产物。
 *
 * 为什么用 iframe：archify 产物自带 theme / 样式 / 播放与导出工具，塞进 SPA 会跟
 * 应用外壳的样式打架（它甚至有自己的一套 CSS 变量与快捷键）。独立 document 是
 * 唯一稳的隔离方式。
 *
 * 为什么不给 pi 原生图单开路由：两边共用同一个宿主（顶部 tab + iframe + 深链），
 * 单开路由只会把同一段代码复制两遍，而「集合」这个维度是数据不是路由。
 *
 * URL：`?set=<collection>&d=<slug>`。只给 `d` 的老链接按 slug 反查集合，仍可打开。
 * 每个集合记住上次看的那张图（localStorage），切回来不会跳回第一张。
 */
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ARCHITECTURE_COLLECTIONS,
  resolveArchitectureView,
  type ArchitectureCollection,
} from '../constants/architecture-diagrams';

const route = useRoute();
const router = useRouter();

const current = computed(() => resolveArchitectureView(route.query.set, route.query.d));
const collection = computed(() => current.value.collection);
const diagram = computed(() => current.value.diagram);

// Vite 提供托管前缀；dev 是 `/`，打包后是 `/web/`。
const diagramUrl = computed(() =>
  diagram.value ? `${import.meta.env.BASE_URL}architecture/${diagram.value.file}` : '',
);

const barHint = computed(() => diagram.value?.hint ?? collection.value.hint);

/** 每个集合记住上次看的图，切回来时还原。 */
const STORAGE_PREFIX = 'pi-web-architecture:';

function readRemembered(collectionId: string): string | null {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${collectionId}`);
  } catch {
    return null;
  }
}

function remember(collectionId: string, slug: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${collectionId}`, slug);
  } catch {
    /* localStorage 不可用（隐私模式）时忽略 */
  }
}

function go(nextSet: string, nextSlug: string | null): void {
  const query: Record<string, string> = { ...(route.query as Record<string, string>), set: nextSet };
  if (nextSlug) query.d = nextSlug;
  else delete query.d;
  void router.replace({ query });
}

function selectCollection(target: ArchitectureCollection): void {
  if (target.id === collection.value.id) return;
  const remembered = readRemembered(target.id);
  const next = target.diagrams.find((d) => d.slug === remembered) ?? target.diagrams[0] ?? null;
  go(target.id, next?.slug ?? null);
}

function selectDiagram(slug: string): void {
  if (slug === diagram.value?.slug) return;
  go(collection.value.id, slug);
}

// 记住当前图（含从老链接直接进来的情况）
watch(
  diagram,
  (value) => {
    if (value) remember(collection.value.id, value.slug);
  },
  { immediate: true },
);
</script>

<template>
  <div class="architecture-page">
    <div class="architecture-bar">
      <div class="architecture-collections" role="tablist" aria-label="图集合">
        <button
          v-for="item in ARCHITECTURE_COLLECTIONS"
          :key="item.id"
          type="button"
          role="tab"
          class="architecture-collection"
          :class="{ 'architecture-collection--active': item.id === collection.id }"
          :aria-selected="item.id === collection.id"
          :title="item.hint"
          @click="selectCollection(item)"
        >
          {{ item.label }}
        </button>
      </div>

      <span class="architecture-divider" aria-hidden="true" />

      <div v-if="collection.diagrams.length > 0" class="architecture-tabs" role="tablist" aria-label="架构图切换">
        <button
          v-for="item in collection.diagrams"
          :key="item.slug"
          type="button"
          role="tab"
          class="architecture-tab"
          :class="{ 'architecture-tab--active': item.slug === diagram?.slug }"
          :aria-selected="item.slug === diagram?.slug"
          :title="item.hint"
          @click="selectDiagram(item.slug)"
        >
          {{ item.label }}
        </button>
      </div>

      <p class="architecture-hint">{{ barHint }}</p>
    </div>

    <iframe
      v-if="diagram"
      :key="diagram.slug"
      class="architecture-viewer"
      :src="diagramUrl"
      :title="diagram.hint"
      allow="clipboard-write; fullscreen"
    />
    <div v-else class="architecture-empty">
      <p class="architecture-empty-title">{{ collection.emptyHint }}</p>
      <p class="architecture-empty-meta">集合「{{ collection.label }}」· 选定主题后加到这里，与本平台的图互不影响</p>
    </div>
  </div>
</template>

<style scoped>
.architecture-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.architecture-bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border-subtle);
  background: var(--surface);
}

/* 一级：集合（比图 tab 更重，选出「这是谁的世界」） */
.architecture-collections {
  display: flex;
  flex: none;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.architecture-collection {
  flex: none;
  padding: 4px 11px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.architecture-collection:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.architecture-collection--active,
.architecture-collection--active:hover {
  color: var(--accent-ink);
  background: var(--accent-soft);
}

.architecture-collection:focus-visible,
.architecture-tab:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}

.architecture-divider {
  flex: none;
  width: 1px;
  height: 18px;
  background: var(--border);
}

/* 二级：集合内的图 */
.architecture-tabs {
  display: flex;
  flex: none;
  gap: 4px;
  padding: 3px;
  border-radius: var(--radius-md);
  background: var(--surface-subtle);
  overflow-x: auto;
  scrollbar-width: none;
}

.architecture-tabs::-webkit-scrollbar {
  display: none;
}

.architecture-tab {
  flex: none;
  padding: 5px 12px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.architecture-tab:hover {
  color: var(--text);
  background: var(--surface-hover);
}

.architecture-tab--active,
.architecture-tab--active:hover {
  color: var(--accent-ink);
  background: var(--surface);
  box-shadow: var(--shadow-soft);
}

.architecture-hint {
  min-width: 0;
  margin: 0;
  color: var(--text-tertiary);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.architecture-viewer {
  display: block;
  flex: 1;
  width: 100%;
  min-height: 0;
  border: 0;
  background: var(--bg);
}

.architecture-empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 32px;
  background: var(--bg);
  text-align: center;
}

.architecture-empty-title {
  margin: 0;
  color: var(--text-secondary);
  font-size: 15px;
  font-weight: 600;
}

.architecture-empty-meta {
  margin: 0;
  color: var(--text-tertiary);
  font-size: 12px;
}

/* 紧凑断点下只留两级切换器，说明文字让位给图本身 */
@media (max-width: 860px) {
  .architecture-hint {
    display: none;
  }
}
</style>
