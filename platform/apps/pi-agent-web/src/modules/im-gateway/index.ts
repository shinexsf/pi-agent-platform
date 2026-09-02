/**
 * im-gateway/index.ts — web-side channel admin page registry.
 *
 * Uses Vite import.meta.glob to statically discover channel admin entries at
 * build time. Filters by manifest at runtime (server is authoritative).
 *
 * Exports:
 *   - channelAdminRegistry: array of all known ChannelAdminPage entries
 *   - loadChannelManifest(): async fetch + filter
 *   - buildImGatewayChildren(): generate Vue Router children
 *   - buildImGatewayRoute(): generate parent route for /im
 */
import type { ChannelAdminPage } from '@pi-agent-platform/channel-types';
import type { RouteRecordRaw } from 'vue-router';

// Eagerly-loaded glob for channel admin pages.
//
// Path is RELATIVE to this file (apps/pi-agent-web/src/modules/im-gateway/index.ts).
// Five levels of ".." reach platform/, then "channels/<name>/src/admin/index.ts".
//
// (Note: the JSDoc-comment-with-asterisk-slash form intentionally avoids
// embedding the path string in a docblock — TS would misparse */ inside
// the pattern as the closing of the comment block.)
//
// Absolute paths were tried first but Vite resolves them against the web
// app root (apps/pi-agent-web/), not the platform root — so the absolute
// form would never match the actual channels folder under platform/.
const allChannelAdminPages = import.meta.glob<{ default: ChannelAdminPage }>(
  '../../../../../channels/*/src/admin/index.ts',
  { eager: true },
);

export const channelAdminRegistry: ChannelAdminPage[] = Object.values(allChannelAdminPages)
  .map((m) => m.default)
  .filter((p): p is ChannelAdminPage => !!p && typeof p === 'object');

/** Fetch the runtime manifest and filter the registry. */
export async function loadChannelManifest(): Promise<ChannelAdminPage[]> {
  try {
    const res = await fetch('/api/im/manifest');
    if (!res.ok) {
      console.warn('[im-gateway] manifest fetch failed:', res.status);
      return channelAdminRegistry;
    }
    const data = (await res.json()) as { channels: string[] };
    const enabledTypes = new Set(data.channels);
    return channelAdminRegistry.filter((p) => enabledTypes.has(p.channelType));
  } catch (err) {
    console.warn('[im-gateway] manifest fetch error:', err);
    return channelAdminRegistry;
  }
}

/** Generate Vue Router children from the (filtered) registry. */
export function buildImGatewayChildren(pages: ChannelAdminPage[]): RouteRecordRaw[] {
  const children: RouteRecordRaw[] = [];
  for (const page of pages) {
    children.push({
      path: page.channelType,
      component: page.component,
      meta: {
        navLabel: page.navItem.label,
        navOrder: page.navItem.order,
        navIcon: page.navItem.icon,
        channelType: page.channelType,
      },
    });
    if (page.subRoutes) {
      for (const sub of page.subRoutes) {
        children.push({
          path: page.channelType + sub.path,
          component: sub.component,
          meta: sub.meta ?? {},
        });
      }
    }
  }
  return children;
}

/** Generate parent route record for /im. */
export function buildImGatewayRoute(pages: ChannelAdminPage[]): RouteRecordRaw {
  return {
    path: '/im',
    component: () => import('./ImGatewayLayout.vue'),
    children: [
      { path: '', redirect: pages[0] ? `/im/${pages[0].channelType}` : '/agents' },
      ...buildImGatewayChildren(pages),
    ],
  };
}
