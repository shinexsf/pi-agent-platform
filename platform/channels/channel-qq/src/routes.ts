/**
 * QQ channel routes — mounted under /api/im/qq/* by the host.
 *
 * MVP: 7 routes (no bindings). Group chat support deferred.
 */

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ChannelConfig, ChannelHost } from '@pi-agent-platform/channel-types';
import { SCHEMA_HINTS, MIGRATION_SQL } from './schema.js';
import { QqAdapter } from './adapter.js';
import { registerChannel } from '../../shared/channel-registry.js';
import { logger } from '../../shared/logger.js';

const CreateChannelSchema = z.object({
  displayName: z.string().min(1).max(64),
  defaultAgentId: z.string().min(1),
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  autoReconnect: z.boolean().optional(),
});

/** Escape single quotes for SQL string literals. */
function escape(s: string): string {
  return s.replace(/'/g, "''");
}

/** SQL value: NULL or escaped single-quoted string. */
function sqlStr(s: string | null | undefined): string {
  if (s === null || s === undefined) return 'NULL';
  return `'${escape(s)}'`;
}

const UpdateChannelSchema = CreateChannelSchema.partial().extend({
  enabled: z.boolean().optional(),
  currentSessionId: z.string().optional(),
});

interface ChannelRoutesState {
  activeAdapters: Map<string, import('@pi-agent-platform/channel-types').ChannelAdapter>;
}

export function createQqRoutes(host: ChannelHost): { router: Hono; state: ChannelRoutesState } {
  const router = new Hono();
  const state: ChannelRoutesState = { activeAdapters: new Map() };

  router.get('/channels', (c) => {
    const all = host.listChannelConfigs().filter((cfg) => cfg.type === 'qq');
    return c.json({ channels: all });
  });

  router.get('/channels/status', (c) => {
    const all = host.listChannelConfigs().filter((cfg) => cfg.type === 'qq');
    const statusMap: Record<string, string> = {};
    for (const cfg of all) {
      const adapter = state.activeAdapters.get(cfg.id);
      statusMap[cfg.id] = adapter ? adapter.getStatus().status : 'stopped';
    }
    return c.json({ statusMap });
  });

  router.post('/channels', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateChannelSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request', details: parsed.error.format() }, 400);
    }
    const now = Date.now();
    const id = randomUUID();
    // Persist to DB FIRST so the row survives server restarts.
    host.exec(
      `INSERT INTO channels_qq (id, display_name, enabled, default_agent_id, current_session_id, app_id, app_secret, auto_reconnect, created_at, updated_at) ` +
      `VALUES ('${id}', '${escape(parsed.data.displayName)}', 1, ${sqlStr(parsed.data.defaultAgentId)}, NULL, '${escape(parsed.data.appId)}', '${escape(parsed.data.appSecret)}', ${parsed.data.autoReconnect === false ? 0 : 1}, ${now}, ${now})`
    );
    const config: ChannelConfig = {
      id,
      type: 'qq',
      displayName: parsed.data.displayName,
      enabled: true,
      defaultAgentId: parsed.data.defaultAgentId,
      createdAt: now,
      updatedAt: now,
      extra: {
        appId: parsed.data.appId,
        appSecret: parsed.data.appSecret,
        autoReconnect: parsed.data.autoReconnect ?? true,
      },
    };
    const created = host.createChannelConfig(config);
    logger.info({ channelId: created.id, displayName: created.displayName }, 'qq channel created');
    return c.json(created, 201);
  });

  router.get('/channels/:id', (c) => {
    const id = c.req.param('id');
    const cfg = host.getChannelConfig(id);
    if (!cfg || cfg.type !== 'qq') return c.json({ error: 'Channel not found' }, 404);
    return c.json(cfg);
  });

  router.patch('/channels/:id', async (c) => {
    const id = c.req.param('id');
    const cfg = host.getChannelConfig(id);
    if (!cfg || cfg.type !== 'qq') return c.json({ error: 'Channel not found' }, 404);
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
      type: 'qq',
      updatedAt: now,
    };

    // Persist the updated columns to DB. We only UPDATE the fields the user
    // actually sent (no-op for unchanged fields).
    const setParts: string[] = [];
    if (parsed.data.displayName !== undefined) setParts.push(`display_name = '${escape(parsed.data.displayName)}'`);
    if (parsed.data.defaultAgentId !== undefined) setParts.push(`default_agent_id = ${sqlStr(parsed.data.defaultAgentId)}`);
    if (parsed.data.currentSessionId !== undefined) setParts.push(`current_session_id = ${sqlStr(parsed.data.currentSessionId)}`);
    if (parsed.data.appId !== undefined) setParts.push(`app_id = '${escape(parsed.data.appId)}'`);
    if (parsed.data.appSecret !== undefined) setParts.push(`app_secret = '${escape(parsed.data.appSecret)}'`);
    if (parsed.data.autoReconnect !== undefined) setParts.push(`auto_reconnect = ${parsed.data.autoReconnect ? 1 : 0}`);
    if (parsed.data.enabled !== undefined) setParts.push(`enabled = ${parsed.data.enabled ? 1 : 0}`);
    setParts.push(`updated_at = ${now}`);
    if (setParts.length > 1) {
      host.exec(`UPDATE channels_qq SET ${setParts.join(', ')} WHERE id = '${id}'`);
    }

    host.updateChannelConfig(updated);

    // If defaultAgentId changed and a session is currently bound, kill the
    // worker so the next inbound re-spawns with the new agent. We do NOT
    // rewrite SessionMeta.agentId here (sessions are immutable from the IM
    // gateway's perspective — the chat→session binding stays, but a fresh
    // worker loads the new agent's prompt/tools/model on next prompt()).
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

  router.delete('/channels/:id', async (c) => {
    const id = c.req.param('id');
    const cfg = host.getChannelConfig(id);
    if (!cfg || cfg.type !== 'qq') return c.json({ error: 'Channel not found' }, 404);
    const adapter = state.activeAdapters.get(id);
    if (adapter) {
      await adapter.stop().catch(() => undefined);
      state.activeAdapters.delete(id);
    }
    host.deleteChannelConfig(id);
    host.exec(`DELETE FROM channels_qq WHERE id = '${id}'`);
    return c.json({ ok: true });
  });

  // POST /qr-login — creates a row with PLACEHOLDER appId/appSecret (filled in
  // later by the connector's onSuccess callback). Only displayName +
  // defaultAgentId are required at this stage — actual bot credentials come
  // from scanning the QR with mobile QQ.
  const QrLoginSchema = z.object({
    // Optional — QQ fetches the bot's display name from /users/@me after QR scan.
    // Caller can still supply one (e.g. for legacy web UI flows); default is a
    // placeholder that's overwritten by the connector's onSuccess callback.
    displayName: z.string().min(1).max(64).optional(),
    defaultAgentId: z.string().min(1),
  });
  router.post('/qr-login', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = QrLoginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request', details: parsed.error.format() }, 400);
    }
    const now = Date.now();
    const id = randomUUID();
    // Placeholder displayName — QQ SDK overwrites it with /users/@me on QR success.
    const placeholderName = parsed.data.displayName ?? 'Pending QR Login';
    // Persist to DB with empty placeholders. Will be updated on QR success.
    host.exec(
      `INSERT INTO channels_qq (id, display_name, enabled, default_agent_id, current_session_id, app_id, app_secret, auto_reconnect, created_at, updated_at) ` +
      `VALUES ('${id}', '${escape(placeholderName)}', 1, ${sqlStr(parsed.data.defaultAgentId)}, NULL, '', '', 1, ${now}, ${now})`
    );
    const config: ChannelConfig = {
      id,
      type: 'qq',
      displayName: placeholderName,
      enabled: true,
      defaultAgentId: parsed.data.defaultAgentId,
      createdAt: now,
      updatedAt: now,
      extra: { appId: '', appSecret: '', autoReconnect: true },
    };
    const created = host.createChannelConfig(config);
    return c.json({ channelId: created.id }, 201);
  });

  // POST /channels/:id/start-qr — starts the QR login flow. The adapter calls
  // `startQrConnect` (q.qq.com), which emits a scan URL via SSE. When the
  // user scans with mobile QQ, the connector returns appId+appSecret, and
  // our onCredentials callback persists them to DB + updates the in-memory
  // config + sets up the WebSocket.
  router.post('/channels/:id/start-qr', async (c) => {
    const id = c.req.param('id');
    const cfg = host.getChannelConfig(id);
    if (!cfg || cfg.type !== 'qq') return c.json({ error: 'Channel not found' }, 404);
    if (state.activeAdapters.has(id)) {
      return c.json({ error: 'Channel already started' }, 409);
    }
    const extra = cfg.extra as { appId?: string; appSecret?: string } | undefined;
    const adapter = new QqAdapter({
      config: cfg,
      host: {
        logEvent: (e) => host.logEvent(e),
        onCredentials: (creds) => {
          // Persist to DB
          const now = Date.now();
          host.exec(
            `UPDATE channels_qq SET app_id = '${escape(creds.appId)}', app_secret = '${escape(creds.appSecret)}', display_name = '${escape(creds.displayName)}', updated_at = ${now} WHERE id = '${id}'`
          );
          // Update in-memory config (so subsequent restarts have credentials)
          const updated: ChannelConfig = {
            ...cfg,
            displayName: creds.displayName,
            updatedAt: now,
            extra: { ...(cfg.extra as Record<string, unknown>), appId: creds.appId, appSecret: creds.appSecret },
          };
          host.updateChannelConfig(updated);
          logger.info({ channelId: id, displayName: creds.displayName }, 'qq qr-success: credentials persisted');
        },
      },
      appId: extra?.appId ?? '',
      appSecret: extra?.appSecret ?? '',
    });
    adapter.onMessage(async (msg) => {
      logger.info({ msg: msg.text, channelId: msg.channelId, isGroup: msg.isGroup }, 'qq inbound');
      // Forward to host routing layer → session bridge → agent → reply-sender.
      await host.handleInbound(msg);
    });
    adapter.onError((channelId, err) => {
      host.logEvent({ channelId, channelType: 'qq', kind: 'error', message: err.message });
    });
    state.activeAdapters.set(id, adapter);
    registerChannel({
      channelId: cfg.id,
      channelType: 'qq',
      config: cfg,
      adapter,
      status: adapter.getStatus(),
    });
    void adapter.start().catch((err: Error) => {
      host.logEvent({ channelId: id, channelType: 'qq', kind: 'start-failed', message: err.message });
    });
    return c.json({ ok: true, channelId: id });
  });

  router.post('/channels/:id/start', async (c) => {
    const id = c.req.param('id');
    const cfg = host.getChannelConfig(id);
    if (!cfg || cfg.type !== 'qq') return c.json({ error: 'Channel not found' }, 404);
    if (state.activeAdapters.has(id)) {
      return c.json({ error: 'Channel already started' }, 409);
    }
    const extra = cfg.extra as { appId?: string; appSecret?: string } | undefined;
    const adapter = new QqAdapter({
      config: cfg,
      host: { logEvent: (e) => host.logEvent(e) },
      appId: extra?.appId ?? '',
      appSecret: extra?.appSecret ?? '',
    });
    adapter.onMessage(async (msg) => {
      logger.info({ msg: msg.text, channelId: msg.channelId, isGroup: msg.isGroup }, 'qq inbound');
      await host.handleInbound(msg);
    });
    adapter.onError((channelId, err) => {
      host.logEvent({
        channelId,
        channelType: 'qq',
        kind: 'error',
        message: err.message,
      });
    });
    state.activeAdapters.set(id, adapter);
    registerChannel({
      channelId: cfg.id,
      channelType: 'qq',
      config: cfg,
      adapter,
      status: adapter.getStatus(),
    });
    await adapter.start();
    return c.json({ ok: true, status: adapter.getStatus().status });
  });

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

export { SCHEMA_HINTS, MIGRATION_SQL };