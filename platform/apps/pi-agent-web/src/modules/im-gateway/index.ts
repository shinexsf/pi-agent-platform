/**
 * im-gateway/index.ts — web-side channel admin page registry.
 *
 * Uses Vite import.meta.glob to statically discover channel admin entries at
 * build time. Filters by manifest at runtime (server is authoritative).
 *
 * Exports:
 *   - channelAdminRegistry: array of all known ChannelAdminPage entries
 *   - loadChannelManifest(): async fetch + filter
 */
import type { ChannelAdminPage } from '@pi-agent-platform/channel-types';

export type { ChannelAdminPage };

// Eagerly-loaded glob for channel admin pages.
//
// Path is RELATIVE to this file (apps/pi-agent-web/src/modules/im-gateway/index.ts).
// Five levels of ".." reach platform/, then "channels/<name>/src/admin/index.ts".
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
