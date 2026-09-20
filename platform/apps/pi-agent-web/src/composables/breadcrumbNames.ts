/**
 * breadcrumbNames — 共享缓存，路由页加载后写入 ID→名称映射，面包屑读取。
 */
import { ref } from 'vue';

const cache = ref<Map<string, string>>(new Map());

export function setCrumbName(id: string, name: string): void {
  cache.value.set(id, name);
}

export function getCrumbName(id: string): string | undefined {
  return cache.value.get(id);
}
