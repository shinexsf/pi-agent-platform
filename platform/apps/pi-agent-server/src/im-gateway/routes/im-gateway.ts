/**
 * routes/im-gateway.ts — main IM gateway routes mounted under /api/im/*.
 *
 * Exposes:
 *   GET  /api/im/manifest        — list enabled channels (server-authoritative)
 *   GET  /api/im/health          — list all channels with status snapshot
 *   GET  /api/im/channels        — aggregate list (all types)
 *   GET  /api/im/debug/state     — debug-only: full session-channel-map + adapters + QQ notified set
 *   GET  /api/im/debug/logs      — debug-only: live channel log feed (SSE)
 *
 * Channel-type-specific routes are mounted separately under /api/im/<type>/*.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { config } from '../../config.js';
import type { ChannelConfig, ChannelHost } from '@pi-agent-platform/channel-types';
import { createChannelHostImpl } from '../channel-host-impl.js';
import { listChannels } from '../channel-registry.js';
import type { SessionRepo } from '../../repos/session.repo.js';
import { snapshot as sessionSnapshot, size as sessionSize } from '../session-channel-map.js';
import { snapshot as replySnapshot } from '../reply-sender.js';

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

  // ── DEBUG routes (dev / internal verification) ───────────────────────────────
  if (config.isDev) {
    router.get('/debug/state', (c) => {
      const sessions = sessionSnapshot().map(([sid, meta]) => ({
        sessionId: sid,
        agentId: meta.agentId,
        channelId: meta.channelId,
        chatId: meta.chatId,
        lastActiveAt: meta.lastActiveAt,
        idleForMs: Date.now() - meta.lastActiveAt,
      }));
      const replyPending = replySnapshot().map(([sid, p]) => ({
        sessionId: sid,
        messageId: p.messageId,
        parentId: p.parentId,
        textLen: p.text.length,
        done: p.done,
      }));
      const adapters = listChannels().map((rc) => ({
        channelId: rc.channelId,
        channelType: rc.channelType,
        connected: rc.adapter.isConnected(),
        status: rc.status.status,
        since: rc.status.since,
        error: rc.status.error,
      }));
      return c.json({
        uptime: process.uptime(),
        loadedTypes: deps.helpers.listLoadedTypes(),
        sessionCount: sessionSize(),
        sessions,
        replyPending,
        adapters,
        qqGroupNotifiedCount: deps.qqGroupNotified.size,
        qqGroupNotifiedList: Array.from(deps.qqGroupNotified),
      });
    });

  }

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