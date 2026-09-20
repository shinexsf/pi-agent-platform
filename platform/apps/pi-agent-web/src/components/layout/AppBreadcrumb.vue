<script setup lang="ts">
/**
 * AppBreadcrumb — 顶部栏面包屑，真实反映当前路由层级。
 *
 * 层级来源：
 *   1. 一级项：nav-tree 中 `isWithin(route.path, node.path)` 的路由
 *   2. 二级项：该一级项下匹配的 children
 *   3. 更深一层：路由 `meta.crumbTitle`（静态）或 `meta.crumbTitleFromParam`（取路由参数）
 *
 * 契约（spec app-layout）：除最后一段外每一段可点击；紧凑断点下仍可见。
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useNavTree, isWithin } from './nav-tree';
import { getCrumbName } from '../../composables/breadcrumbNames';

interface Crumb {
  label: string;
  to?: string;
}

interface BreadcrumbMeta {
  crumbTitle?: unknown;
  crumbTitleFromParam?: unknown;
}

const route = useRoute();
const { nodes } = useNavTree();

const crumbs = computed<Crumb[]>(() => {
  const path = route.path;
  const result: Crumb[] = [];

  const top = nodes.value.find((node) => isWithin(path, node.path));
  if (top) {
    result.push({ label: top.label, to: top.path });
    const leaf = top.children.find((child) => isWithin(path, child.path));
    if (leaf) {
      result.push(leaf.path === path ? { label: leaf.label } : { label: leaf.label, to: leaf.path });
    }
  }

  const meta = route.meta as BreadcrumbMeta;
  // 参数段（如 `:name`）在前，静态标题（如「编辑 Provider」）在后
  if (typeof meta.crumbTitleFromParam === 'string' && meta.crumbTitleFromParam) {
    const raw = route.params[meta.crumbTitleFromParam];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value) {
      const resolved = getCrumbName(value);
      result.push({ label: resolved || value });
    }
  }
  if (typeof meta.crumbTitle === 'string' && meta.crumbTitle) {
    result.push({ label: meta.crumbTitle });
  }

  // 最后一段永远是当前页 → 不可点击
  return result.map((crumb, index) =>
    index === result.length - 1 ? { label: crumb.label } : crumb,
  );
});
</script>

<template>
  <nav v-if="crumbs.length > 0" class="app-breadcrumb" aria-label="面包屑">
    <template v-for="(crumb, index) in crumbs" :key="`${crumb.label}-${index}`">
      <span v-if="index > 0" class="app-breadcrumb-sep" aria-hidden="true">/</span>
      <router-link v-if="crumb.to" class="app-breadcrumb-link" :to="crumb.to">
        {{ crumb.label }}
      </router-link>
      <span v-else class="app-breadcrumb-current" aria-current="page">{{ crumb.label }}</span>
    </template>
  </nav>
</template>

<style scoped>
.app-breadcrumb {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
  font-size: 0.82rem;
  font-weight: 620;
  overflow: hidden;
  white-space: nowrap;
}

.app-breadcrumb-sep {
  color: var(--text-secondary);
  opacity: 0.55;
  flex: none;
}

.app-breadcrumb-link {
  flex: none;
  color: var(--text-secondary);
  text-decoration: none;
}

.app-breadcrumb-link:hover {
  color: var(--text);
}

.app-breadcrumb-current {
  min-width: 0;
  overflow: hidden;
  color: var(--text);
  font-weight: 700;
  text-overflow: ellipsis;
}
</style>
