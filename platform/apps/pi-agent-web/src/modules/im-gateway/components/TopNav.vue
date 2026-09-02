<script setup lang="ts">
/**
 * TopNav — data-driven horizontal navigation bar.
 *
 * Reads all Vue Router routes, filters those with `meta.navLabel`, sorts by
 * `meta.navOrder` (default 100). Renders one link per entry with the label
 * alongside one shared, authored SVG icon family.
 */
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '../../../components/ui/AppIcon.vue';

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

function iconName(entry: NavEntry): string {
  if (entry.icon && !/[\p{Extended_Pictographic}]/u.test(entry.icon)) return entry.icon;
  if (entry.path.includes('/wechat')) return 'wechat';
  if (entry.path.includes('/qq')) return 'qq';
  if (entry.path.includes('/sessions')) return 'sessions';
  return 'agents';
}
</script>

<template>
  <nav class="top-nav" aria-label="Primary navigation">
    <router-link
      v-for="entry in navEntries"
      :key="entry.path"
      :to="entry.path"
      :class="['nav-link', { active: entry.isActive }]"
      :style="entry.isActive ? { viewTransitionName: 'nav-active' } : undefined"
      :aria-current="entry.isActive ? 'page' : undefined"
    >
      <AppIcon :name="iconName(entry)" :size="17" />
      <span class="nav-label">{{ entry.label }}</span>
    </router-link>
  </nav>
</template>

<style scoped>
.top-nav {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 5px;
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: none;
}
.top-nav::-webkit-scrollbar {
  display: none;
}
.nav-link {
  display: inline-flex;
  min-height: 38px;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 9px;
  color: var(--text-secondary);
  text-decoration: none;
  font-size: 0.79rem;
  font-weight: 650;
  transition: background-color 150ms ease, color 150ms ease;
}
.nav-link:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.nav-link.active {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.nav-label { line-height: 1; }

@media (max-width: 680px) {
  .top-nav {
    grid-column: 1 / -1;
    width: calc(100% + 32px);
    margin-left: -16px;
    padding: 0 16px 9px;
    justify-content: flex-start;
  }

  .nav-link {
    min-height: 36px;
    padding: 8px 11px;
  }
}
</style>
