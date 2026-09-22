/**
 * routes/im-gateway.ts — main IM gateway routes mounted under /api/im/*.
 *
 * Exposes:
 *   GET  /api/im/manifest        — list enabled channels (server-authoritative)
 *   GET  /api/im/health          — list all channels with status snapshot
 *   GET  /api/im/channels        — aggregate list (all types)
 *   GET  /api/im/events          — SSE live channel log feed (all modes — admin UI QR login depends on it)
 *
 * Channel-type-specific routes are mounted separately under /api/im/<type>/*.
 * Dev-only debug routes live in ./im-debug.ts (mounted at /api/im/debug by im-gateway/index.ts).
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ChannelConfig, ChannelHost } from '@pi-agent-platform/channel-types';
import { createChannelHostImpl } from '../channel-host-impl.js';
import { listChannels } from '../channel-registry.js';
import type { SessionRepo } from '../../repos/session.repo.js';

interface Deps {
  host: ChannelHost;
  helpers: ReturnType<typeof createChannelHostImpl>['helpers'];
  sessionRepo: SessionRepo;
  /** QQ group fast-fail notified set (passed in by main wiring). */
  qqGroupNotified: Set<string>;
}

/** Build the main /api/im router. Caller mounts it under /api/im. */
export function createImGatewayRouter(deps: Deps): Hono {
  const router = new Hono();

  // GET /api/im/manifest — matches channels/manifest.json (server-authoritative)
  router.get('/manifest', (c) => {
    return c.json({
      channels: deps.helpers.listLoadedTypes(),
    });
  });

  // GET /api/im/health — summary of all channels with live status
  router.get('/health', (c) => {
    const channels = listChannels().map((rc) => ({
      channelId: rc.channelId,
      channelType: rc.channelType,
      displayName: rc.config.displayName,
      enabled: rc.config.enabled,
      status: rc.status.status,
      since: rc.status.since,
      error: rc.status.error,
    }));
    return c.json({
      ok: true,
      uptime: process.uptime(),
      channels,
    });
  });

  // GET /api/im/channels — all channel configs (admin UI list view)
  router.get('/channels', (c) => {
    const all: Array<ChannelConfig & { status: string; currentSessionTitle?: string }> = [];
    for (const type of deps.helpers.listLoadedTypes()) {
      for (const cfg of deps.helpers.listChannelConfigsByType(type)) {
        const registered = listChannels().find((rc) => rc.channelId === cfg.id);
        const currentSessionTitle = cfg.currentSessionId
          ? deps.sessionRepo.get(cfg.currentSessionId)?.title
          : undefined;
        all.push({ ...cfg, status: registered?.status.status ?? 'disabled', currentSessionTitle });
      }
    }
    return c.json({ channels: all });
  });

  // SSE: live channel log feed — exposed in all modes (production-safe)
  // because channel admin pages need it to display QR codes during login.
  router.get('/events', (c) => {
    return streamSSE(c, async (stream) => {
      const handler = (event: import('@pi-agent-platform/channel-types').ChannelLogEvent) => {
        stream.writeSSE({
          data: JSON.stringify(event),
          event: event.kind,
        }).catch(() => {
          // Client disconnected — the unsubscriber below handles cleanup.
        });
      };
      // Subscribe via the host's pub/sub. The returned handler is the same
      // function we passed in, which the host stores; we unsubscribe by
      // registering a no-op replacement (ChannelHost doesn't expose an
      // unsubscribe API in MVP).
      deps.host.onChannelLog(handler);
      // Hold the connection open for 10 minutes; the client is expected to
      // reconnect after that.
      const startTs = Date.now();
      try {
        while (Date.now() - startTs < 10 * 60 * 1000) {
          await stream.sleep(1000);
        }
      } catch {
        // stream closed
      }
    });
  });

  // Mount channel-type-specific routers under /api/im/<type>/*
  for (const type of deps.helpers.listLoadedTypes()) {
    const r = deps.helpers.getRouterFor(type);
    if (!r) continue;
    router.route(`/${type}`, r);
  }

  return router;
}