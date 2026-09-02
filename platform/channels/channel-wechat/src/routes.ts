/**
 * WeChat channel routes — mounted under /api/im/wechat/* by the host.
 *
 * 8 routes (MVP QR-login flow):
 *   GET    /channels                    list
 *   POST   /channels                    create (manual — for advanced users)
 *   GET    /channels/:id                detail
 *   PATCH  /channels/:id                update
 *   DELETE /channels/:id                delete
 *   POST   /channels/:id/start          start adapter (assumes QR already done)
 *   POST   /channels/:id/stop           stop adapter
 *   POST   /qr-login                    create row + auto storageDir + return channelId (no start)
 *   POST   /channels/:id/start-qr       trigger SDK login, emits QR via SSE
 *
 * Typical QR-login flow (web admin):
 *   1. POST /qr-login { displayName, defaultAgentId }
 *      → 201 { channelId, storageDir }
 *   2. Browser opens EventSource('/api/im/events?channelId=' + channelId)
 *   3. POST /channels/:id/start-qr
 *      → 200 { ok: true }
 *      → SSE pushes events: qr-url (image), qr-scanned, connected
 *   4. User scans with iOS WeChat; SSE emits 'connected' → admin closes dialog
 */

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelHost,
} from '@pi-agent-platform/channel-types';
import { SCHEMA_HINTS, MIGRATION_SQL } from './schema.js';
import { WechatAdapter } from './adapter.js';
import { registerChannel } from '../../shared/channel-registry.js';
import { logger } from '../../shared/logger.js';

// Zod schemas for validation
const CreateChannelSchema = z.object({
  displayName: z.string().min(1).max(64),
  defaultAgentId: z.string().min(1),
  storageDir: z.string().min(1).optional(),
  autoReconnect: z.boolean().optional(),
});

const UpdateChannelSchema = CreateChannelSchema.partial().extend({
  enabled: z.boolean().optional(),
});

interface ChannelRoutesState {
  /** Map of channelId → active adapter instance (for start/stop). */
  activeAdapters: Map<string, ChannelAdapter>;
}

/** Escape single quotes for SQL string literals. */
function escape(s: string): string {
  return s.replace(/'/g, "''");
}

/** SQL value: NULL or escaped single-quoted string. */
function sqlStr(s: string | null | undefined): string {
  if (s === null || s === undefined) return 'NULL';
  return `'${escape(s)}'`;
}

/** Build the WeChat routes Hono router. */
export function createWechatRoutes(host: ChannelHost): { router: Hono; state: ChannelRoutesState } {
  const router = new Hono();
  const state: ChannelRoutesState = { activeAdapters: new Map() };

  // GET /channels
  router.get('/channels', (c) => {
    const all = host.listChannelConfigs().filter((cfg) => cfg.type === 'wechat');
    return c.json({ channels: all });
  });

  // POST /channels
  router.post('/channels', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateChannelSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request', details: parsed.error.format() }, 400);
    }
    const now = Date.now();
    const id = randomUUID();
    const config: ChannelConfig = {
      id,
      type: 'wechat',
      displayName: parsed.data.displayName,
      enabled: true,
      defaultAgentId: parsed.data.defaultAgentId,
      createdAt: now,
      updatedAt: now,
      extra: {
        storageDir: parsed.data.storageDir,
        autoReconnect: parsed.data.autoReconnect ?? true,
      },
    };
    // Persist to DB FIRST so the row survives server restarts.
    const extra = config.extra as { storageDir: string; autoReconnect: boolean };
    host.exec(
      `INSERT INTO channels_wechat (id, display_name, enabled, default_agent_id, current_session_id, storage_dir, auto_reconnect, created_at, updated_at) ` +
      `VALUES ('${id}', '${escape(parsed.data.displayName)}', 1, ${sqlStr(parsed.data.defaultAgentId)}, NULL, '${escape(extra.storageDir)}', ${extra.autoReconnect ? 1 : 0}, ${now}, ${now})`
    );
    const created = host.createChannelConfig(config);
    logger.info({ channelId: created.id, displayName: created.displayName }, 'wechat channel created');
    return c.json(created, 201);
  });

  // GET /channels/:id
  router.get('/channels/:id', (c) => {
    const id = c.req.param('id');
    const cfg = host.getChannelConfig(id);
    if (!cfg || cfg.type !== 'wechat') return c.json({ error: 'Channel not found' }, 404);
    return c.json(cfg);
  });

  // PATCH /channels/:id
  router.patch('/channels/:id', async (c) => {
    const id = c.req.param('id');
    const cfg = host.getChannelConfig(id);
    if (!cfg || cfg.type !== 'wechat') return c.json({ error: 'Channel not found' }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = UpdateChannelSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request', details: parsed.error.format() }, 400);
    }
    const now = Date.now();
    const updated: ChannelConfig = {
      ...cfg,
      ...parsed.data,
      id,
      type: 'wechat',
      updatedAt: now,
    };

    // Persist changed columns to DB.
    const setParts: string[] = [];
    if (parsed.data.displayName !== undefined) setParts.push(`display_name = '${escape(parsed.data.displayName)}'`);
    if (parsed.data.defaultAgentId !== undefined) setParts.push(`default_agent_id = ${sqlStr(parsed.data.defaultAgentId)}`);
    if (parsed.data.storageDir !== undefined) setParts.push(`storage_dir = '${escape(parsed.data.storageDir)}'`);
    if (parsed.data.autoReconnect !== undefined) setParts.push(`auto_reconnect = ${parsed.data.autoReconnect ? 1 : 0}`);
    if (parsed.data.enabled !== undefined) setParts.push(`enabled = ${parsed.data.enabled ? 1 : 0}`);
    setParts.push(`updated_at = ${now}`);
    if (setParts.length > 1) {
      host.exec(`UPDATE channels_wechat SET ${setParts.join(', ')} WHERE id = '${id}'`);
    }

    host.updateChannelConfig(updated);

    // If defaultAgentId changed, kill the worker so the next inbound re-spawns
    // with the new agent.
    if (parsed.data.defaultAgentId !== undefined && parsed.data.defaultAgentId !== cfg.defaultAgentId) {
      const sessionId = cfg.currentSessionId;
      if (sessionId) {
        try {
          await host.killWorker(sessionId, 'agent-changed');
        } catch (err) {
          logger.warn({ err: String(err), sessionId, channelId: id }, 'failed to kill worker after agent change');
        }
      }
    }

    return c.json(updated);
  });

  // DELETE /channels/:id
  router.delete('/channels/:id', async (c) => {
    const id = c.req.param('id');
    const cfg = host.getChannelConfig(id);
    if (!cfg || cfg.type !== 'wechat') return c.json({ error: 'Channel not found' }, 404);
    // Stop adapter if running
    const adapter = state.activeAdapters.get(id);
    if (adapter) {
      await adapter.stop().catch(() => undefined);
      state.activeAdapters.delete(id);
    }
    host.deleteChannelConfig(id);
    host.exec(`DELETE FROM channels_wechat WHERE id = '${id}'`);
    return c.json({ ok: true });
  });

  // POST /channels/:id/start
  // POST /qr-login — create channel row with auto-generated storageDir, return
  // { channelId, storageDir } so the admin page can subscribe to SSE + then call
  // POST /channels/:id/start-qr to trigger the SDK login flow.
  router.post('/qr-login', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateChannelSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request', details: parsed.error.format() }, 400);
    }
    const now = Date.now();
    const id = randomUUID();
    const storageDir = path.join(os.tmpdir(), `wechat-${id}`);
    // Persist to DB FIRST so the row survives server restarts.
    host.exec(
      `INSERT INTO channels_wechat (id, display_name, enabled, default_agent_id, current_session_id, storage_dir, auto_reconnect, created_at, updated_at) ` +
      `VALUES ('${id}', '${escape(parsed.data.displayName)}', 1, ${sqlStr(parsed.data.defaultAgentId)}, NULL, '${escape(storageDir)}', ${parsed.data.autoReconnect === false ? 0 : 1}, ${now}, ${now})`
    );
    const config: ChannelConfig = {
      id,
      type: 'wechat',
      displayName: parsed.data.displayName,
      enabled: true,
      defaultAgentId: parsed.data.defaultAgentId,
      createdAt: now,
      updatedAt: now,
      extra: {
        storageDir,
        autoReconnect: parsed.data.autoReconnect ?? true,
      },
    };
    host.createChannelConfig(config);
    logger.info({ channelId: id, storageDir }, 'wechat qr-login: row created, storageDir auto-assigned');
    return c.json({ channelId: id, storageDir }, 201);
  });

  // POST /channels/:id/start-qr — trigger SDK login. The adapter will emit
  // qr-url / qr-scanned / connected events via the host.logEvent pipeline,
  // which the admin page subscribes to via /api/im/events SSE.
  router.post('/channels/:id/start-qr', async (c) => {
    const id = c.req.param('id');
    const cfg = host.getChannelConfig(id);
    if (!cfg || cfg.type !== 'wechat') return c.json({ error: 'Channel not found' }, 404);
    if (state.activeAdapters.has(id)) {
      return c.json({ error: 'Channel already started', status: state.activeAdapters.get(id)!.getStatus().status }, 409);
    }
    const storageDir = (cfg.extra as { storageDir?: string } | undefined)?.storageDir;
    if (!storageDir) {
      return c.json({ error: 'storageDir missing on channel config' }, 500);
    }
    const adapter = new WechatAdapter({
      config: cfg,
      host: { logEvent: (e) => host.logEvent(e) },
      storageDir,
      force: true, // explicit QR scan (fresh setup or post-clear)
    });
    // Wire inbound messages → host routing → session bridge → agent → reply-sender.
    adapter.onMessage(async (msg) => {
      logger.info({ msg: msg.text, channelId: msg.channelId, isGroup: msg.isGroup }, 'wechat inbound');
      await host.handleInbound(msg);
    });
    adapter.onError((channelId, err) => {
      host.logEvent({ channelId, channelType: 'wechat', kind: 'error', message: err.message });
    });
    state.activeAdapters.set(id, adapter);
    registerChannel({
      channelId: cfg.id,
      channelType: 'wechat',
      config: cfg,
      adapter,
      status: adapter.getStatus(),
    });
    // Start in background — we don't await because SSE events should arrive
    // to the client (subscribed BEFORE this call) in real-time.
    void adapter.start().catch((err: Error) => {
      host.logEvent({
        channelId: id,
        channelType: 'wechat',
        kind: 'start-failed',
        message: err.message,
      });
    });
    return c.json({ ok: true, channelId: id });
  });

  router.post('/channels/:id/start', async (c) => {
    const id = c.req.param('id');
    const cfg = host.getChannelConfig(id);
    if (!cfg || cfg.type !== 'wechat') return c.json({ error: 'Channel not found' }, 404);
    if (state.activeAdapters.has(id)) {
      return c.json({ error: 'Channel already started' }, 409);
    }
    const storageDir = (cfg.extra as { storageDir?: string } | undefined)?.storageDir ?? `/tmp/wechat-${cfg.id}`;
    const adapter: ChannelAdapter = new WechatAdapter({
      config: cfg,
      host: { logEvent: (e) => host.logEvent(e) },
      storageDir,
      // Reconnect — reuse stored creds from storageDir when present, only
      // fall back to QR if storage is empty / invalidated. This is what the
      // row "Start" button does on an existing channel.
      force: false,
    });
    // Wire inbound messages to host → session bridge → agent → reply-sender.
    adapter.onMessage(async (msg) => {
      logger.info({ msg: msg.text, channelId: msg.channelId }, 'wechat inbound');
      await host.handleInbound(msg);
    });
    adapter.onError((channelId, err) => {
      host.logEvent({
        channelId,
        channelType: 'wechat',
        kind: 'error',
        message: err.message,
      });
    });
    state.activeAdapters.set(id, adapter);
    registerChannel({
      channelId: cfg.id,
      channelType: 'wechat',
      config: cfg,
      adapter,
      status: adapter.getStatus(),
    });
    // Fire-and-forget so HTTP returns immediately. SSE pushes 'qr-url' /
    // 'connected' / 'error' events for the admin to observe. Reference uses
    // the same pattern (bot.start().catch(...) doesn't block the caller).
    //
    // If the user clicks "Start" on a channel that was previously logged in,
    // adapter.start() with force=true re-walks the QR flow (ignores stored
    // creds) and emits a fresh QR URL via SSE. Admin then scans again to
    // re-bind the channel.
    void adapter.start().catch((err: Error) => {
      host.logEvent({
        channelId: id,
        channelType: 'wechat',
        kind: 'start-failed',
        message: err.message,
      });
    });
    return c.json({ ok: true, channelId: id });
  });

  // POST /channels/:id/stop
  router.post('/channels/:id/stop', async (c) => {
    const id = c.req.param('id');
    const adapter = state.activeAdapters.get(id);
    if (!adapter) {
      return c.json({ error: 'Channel not started' }, 409);
    }
    await adapter.stop().catch(() => undefined);
    state.activeAdapters.delete(id);
    return c.json({ ok: true });
  });

  return { router, state };
}

// Re-export schema for admin UI consumption
export { SCHEMA_HINTS, MIGRATION_SQL };