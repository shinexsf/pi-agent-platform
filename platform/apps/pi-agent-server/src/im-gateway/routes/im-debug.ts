/**
 * routes/im-debug.ts — dev-only debug routes for the IM gateway.
 *
 * Extracted from routes/im-gateway.ts so that debug code lives in its own
 * module and is loaded via **dynamic import** in im-gateway/index.ts —
 * production (NODE_ENV=production) never loads this file.
 *
 * Mounted at /api/im/debug/*:
 *   GET /api/im/debug/state — full session-channel-map + adapters + QQ notified set
 *
 * Dependency direction: debug code depends on production code (read-only
 * snapshots), never the other way around.
 */

import { Hono } from 'hono';
import { snapshot as sessionSnapshot, size as sessionSize } from '../session-channel-map.js';
import { snapshot as replySnapshot } from '../reply-sender.js';
import { listChannels } from '../channel-registry.js';

interface Deps {
  /** Loaded channel types (from the host's helpers). */
  listLoadedTypes: () => string[];
  /** QQ group fast-fail notified set (shared with main wiring). */
  qqGroupNotified: Set<string>;
}

/** Build the dev-only IM debug router. Caller mounts it under /api/im/debug. */
export function createImDebugRouter(deps: Deps): Hono {
  const router = new Hono();

  // GET /api/im/debug/state — IM gateway complete state snapshot
  router.get('/state', (c) => {
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
      loadedTypes: deps.listLoadedTypes(),
      sessionCount: sessionSize(),
      sessions,
      replyPending,
      adapters,
      qqGroupNotifiedCount: deps.qqGroupNotified.size,
      qqGroupNotifiedList: Array.from(deps.qqGroupNotified),
    });
  });

  return router;
}
