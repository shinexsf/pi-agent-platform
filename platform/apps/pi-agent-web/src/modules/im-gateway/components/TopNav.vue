<script setup lang="ts">
/**
 * TopNav — data-driven horizontal navigation bar.
 *
 * Reads all Vue Router routes, filters those with `meta.navLabel`, sorts by
 * `meta.navOrder` (default 100). Renders one link per entry with the label
 * (and optional lucide icon — text fallback if icon not installed).
 */
import { computed } from 'vue';
import { useRoute, useRouter, type RouteRecordNormalized } from 'vue-router';

const router = useRouter();
const route = useRoute();

interface NavEntry {
  path: string;
  label: string;
  order: number;
  icon?: string;
  isActive: boolean;
}

const navEntries = computed<NavEntry[]>(() => {
  const all: NavEntry[] = [];
  for (const r of router.getRoutes()) {
    const meta = r.meta as { navLabel?: string; navOrder?: number; navIcon?: string };
    if (!meta.navLabel || typeof meta.navLabel !== 'string') continue;
    all.push({
      path: r.path,
      label: meta.navLabel,
      order: typeof meta.navOrder === 'number' ? meta.navOrder : 100,
      icon: meta.navIcon,
      isActive: isPathActive(r.path),
    });
  }
  all.sort((a, b) => a.order - b.order);
  return all;
});

function isPathActive(path: string): boolean {
  if (path === '/') return route.path === '/';
  return route.path === path || route.path.startsWith(`${path}/`);
}
</script>

<template>
  <nav class="top-nav">
    <router-link
      v-for="entry in navEntries"
      :key="entry.path"
      :to="entry.path"
      :class="['nav-link', { active: entry.isActive }]"
    >
      <span v-if="entry.icon" class="nav-icon">{{ entry.icon }}</span>
      <span class="nav-label">{{ entry.label }}</span>
    </router-link>
  </nav>
</template>

<style scoped>
.top-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 16px;
  height: 48px;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
  overflow-x: auto;
  white-space: nowrap;
}
.nav-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 6px;
  color: #4b5563;
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.1s ease;
}
.nav-link:hover {
  background: #f3f4f6;
  color: #111827;
}
.nav-link.active {
  background: #3b82f6;
  color: white;
}
.nav-icon {
  font-size: 14px;
  opacity: 0.8;
}
.nav-label { line-height: 1; }
</style>