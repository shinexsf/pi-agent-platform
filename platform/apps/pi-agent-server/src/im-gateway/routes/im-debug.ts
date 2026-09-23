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
import type { InboundMessage } from '@pi-agent-platform/channel-types';
import { snapshot as sessionSnapshot, size as sessionSize } from '../session-channel-map.js';
import { snapshot as replySnapshot } from '../reply-sender.js';
import { listChannels } from '../channel-registry.js';

interface Deps {
  /** Loaded channel types (from the host's helpers). */
  listLoadedTypes: () => string[];
  /** QQ group fast-fail notified set (shared with main wiring). */
  qqGroupNotified: Set<string>;
  /** Inject an inbound message through the REAL routing pipeline
   *  (host.handleInbound → routeAndSpawn). Dev-only e2e testing hook —
   *  lets curl exercise slash commands (/new etc) without a live IM client. */
  handleInbound: (msg: InboundMessage) => Promise<void>;
  /** Validate the injection target: channelId → channel type (e.g. "qq"). */
  getChannelType: (channelId: string) => string | null;
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

  // POST /api/im/debug/inject — push an InboundMessage through the real
  // pipeline (handleInbound → routeAndSpawn → session-bridge → worker).
  // Same shape the adapters produce, so behavior matches a real IM message.
  // NOTE: replies still go out through the channel's adapter (real QQ/wechat
  // send) — the injected chat WILL receive them.
  router.post('/inject', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      channelId?: string;
      chatId?: string;
      text?: string;
      isGroup?: boolean;
      senderId?: string;
      chatName?: string;
    } | null;
    if (!body?.channelId || !body.chatId || !body.text) {
      return c.json({ error: 'Missing channelId / chatId / text' }, 400);
    }
    const channelType = deps.getChannelType(body.channelId);
    if (!channelType) {
      return c.json({ error: `Unknown channelId: ${body.channelId}` }, 404);
    }
    const msg: InboundMessage = {
      channelId: body.channelId,
      channelType: channelType as InboundMessage['channelType'],
      chatId: body.chatId,
      chatName: body.chatName ?? 'debug-inject',
      isGroup: body.isGroup ?? false,
      senderId: body.senderId,
      text: body.text,
      timestamp: new Date().toISOString(),
    };
    try {
      await deps.handleInbound(msg);
    } catch (err) {
      // Side effects before the throw (session creation etc) are NOT rolled
      // back — inspect /debug/sessions + /api/im/debug/state to see how far it got.
      return c.json({ ok: false, error: String(err) }, 500);
    }
    return c.json({ ok: true });
  });

  return router;
}
