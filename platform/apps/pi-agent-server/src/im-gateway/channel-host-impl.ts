/**
 * channel-host-impl — concrete implementation of `ChannelHost` exposed to channel
 * packages. Server-side, in-process.
 *
 * Each channel package gets this host when calling `register(host)`. The host:
 *  - owns migrations (channel tables)
 *  - owns route mounting (under /api/im/<type>)
 *  - owns the in-memory session-channel-map
 *  - proxies slash command execution / prompt / kill
 *  - emits log events to admin UI
 *
 * The host does NOT know anything about specific channels (wechat, qq, ...) — it
 * only knows generic operations.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type {
  AgentId,
  ChannelConfig,
  ChannelHost,
  ChannelId,
  ChannelLogEvent,
  ChannelLogHandler,
  ChannelType,
  ExternalChatId,
  ParsedCommand,
  SessionId,
  SessionMeta,
} from '@pi-agent-platform/channel-types';
import { logger } from './logger.js';
import {
  getSessionMeta,
  touchSession as mapTouch,
  setSessionMeta,
  getSessionIdByChat as mapGetSessionIdByChat,
  removeSessionMeta,
} from './session-channel-map.js';
import type { InboundMessage } from '@pi-agent-platform/channel-types';
import type { RouteContext } from './routing.js';

interface Deps {
  /** Resolve agent by id (channel package needs this to validate defaultAgentId). */
  agentExists: (agentId: string) => boolean;
  /** Worker prompt dispatch. */
  promptWorker: (sessionId: SessionId, text: string) => Promise<void>;
  /** Worker kill. */
  killWorker: (sessionId: SessionId, reason: string) => Promise<void>;
  /** Attachment store for uploadAttachment. */
  attachmentStore: import('../services/attachment-store.js').AttachmentStore;
  /** Run a builtin slash command. */
  runBuiltin: (name: string, sessionId: SessionId, args: string) => Promise<string | null>;
  /** Inbound message routing: resolve session, spawn/reuse worker, stream reply. */
  routeInbound: (msg: InboundMessage, ctx: RouteContext) => Promise<void>;
  /** Adapter lookup by channel id (channel package → server routing reply path). */
  getAdapter: (channelType: ChannelType, channelId: ChannelId) => import('@pi-agent-platform/channel-types').ChannelAdapter | null;
  /** Agent repo (passed into RouteContext). */
  agentRepo: import('../repos/agent.repo.js').AgentRepo;
  /** Session repo (passed into RouteContext). */
  sessionRepo: import('../repos/session.repo.js').SessionRepo;
  /** Worker pool (passed into RouteContext). */
  workerPool: import('../worker-pool.js').WorkerPool;
  /** QQ group notified set (shared with routeInbound for fast-fail dedup). */
  qqGroupNotified: Set<string>;
  /** DB handle for executeMigration + query (raw better-sqlite3). */
  db: {
    exec(sql: string): void;
    prepare(sql: string): { all(): unknown[] };
  };
}

interface ChannelState {
  configs: Map<ChannelId, ChannelConfig>;
}

export function createChannelHostImpl(deps: Deps) {
  const logSubscribers = new Set<ChannelLogHandler>();
  // Per channelType → state (in MVP we keep it simple: a flat map + index by type)
  const stateByType = new Map<ChannelType, ChannelState>();
  // Per-type route collectors (hono routers mounted under /api/im/<type>/*)
  const routersByType = new Map<ChannelType, Hono>();

  function stateFor(type: ChannelType): ChannelState {
    let s = stateByType.get(type);
    if (!s) {
      s = { configs: new Map() };
      stateByType.set(type, s);
    }
    return s;
  }

  function routerFor(type: ChannelType): Hono {
    let r = routersByType.get(type);
    if (!r) {
      r = new Hono();
      routersByType.set(type, r);
    }
    return r;
  }

  const host: ChannelHost = {
    executeMigration(_name: string, sql: string): void {
      try {
        deps.db.exec(sql);
        logger.info({ name: _name }, 'channel migration executed');
      } catch (err) {
        logger.error({ err: String(err), name: _name }, 'channel migration failed');
        throw err;
      }
    },

    query(sql: string): unknown[] {
      // better-sqlite3: prepare + all() returns array of objects
      return deps.db.prepare(sql).all() as unknown[];
    },

    exec(sql: string): void {
      // better-sqlite3 exec runs the SQL (with statement caching for prepared statements)
      deps.db.exec(sql);
    },

    registerRoutes(prefix: string, honoRouter: Hono): void {
      // prefix = "/api/im/wechat" → extract type "wechat"
      const parts = prefix.split('/').filter(Boolean);
      const type = parts[parts.length - 1];
      if (!type) throw new Error(`registerRoutes: invalid prefix "${prefix}"`);
      const parent = routerFor(type);
      parent.route('/', honoRouter);
      logger.info({ prefix, type }, 'channel routes registered');
    },

    getChannelConfig(channelId: ChannelId): ChannelConfig | null {
      for (const s of stateByType.values()) {
        const c = s.configs.get(channelId);
        if (c) return c;
      }
      return null;
    },

    listChannelConfigs(): ChannelConfig[] {
      const all: ChannelConfig[] = [];
      for (const s of stateByType.values()) {
        for (const cfg of s.configs.values()) {
          const title = cfg.currentSessionId ? deps.sessionRepo.get(cfg.currentSessionId)?.title : undefined;
          all.push({ ...cfg, currentSessionTitle: title } as ChannelConfig & { currentSessionTitle?: string });
        }
      }
      return all;
    },

    updateChannelConfig(config: ChannelConfig): void {
      const s = stateFor(config.type);
      if (!s.configs.has(config.id)) {
        throw new Error(`updateChannelConfig: channel ${config.id} not found`);
      }
      s.configs.set(config.id, config);
    },

    createChannelConfig(input: Omit<ChannelConfig, 'id'> & { id?: ChannelId }): ChannelConfig {
      // If caller passes id (e.g. startup seeding from DB), use it; else generate.
      const id = input.id ?? randomUUID();
      const config: ChannelConfig = { ...input, id };
      const s = stateFor(input.type);
      s.configs.set(id, config);
      return config;
    },

    deleteChannelConfig(channelId: ChannelId): void {
      for (const s of stateByType.values()) {
        if (s.configs.delete(channelId)) {
          logger.info({ channelId }, 'channel config deleted');
          return;
        }
      }
      throw new Error(`deleteChannelConfig: channel ${channelId} not found`);
    },

    getSessionMeta(sessionId: SessionId): SessionMeta | null {
      return getSessionMeta(sessionId);
    },

    touchSession(sessionId: SessionId): void {
      mapTouch(sessionId);
    },

    setCurrentSession(channelId: ChannelId, chatId: ExternalChatId, sessionId: SessionId): void {
      const cfg = this.getChannelConfig(channelId);
      if (!cfg) throw new Error(`setCurrentSession: channel ${channelId} not found`);
      cfg.currentSessionId = sessionId;
      setSessionMeta(sessionId, {
        agentId: cfg.defaultAgentId ?? '',
        channelId,
        chatId,
        lastActiveAt: Date.now(),
      });
    },

    getCurrentSession(channelId: ChannelId, chatId: ExternalChatId): SessionId | null {
      return mapGetSessionIdByChat(channelId, chatId);
    },

    seedSessionFromConfig(channelId: ChannelId, sessionId: SessionId, chatId?: ExternalChatId, agentId?: AgentId): void {
      logger.debug({ channelId, sessionId, chatId }, '[SESSION-DIAG] seedSessionFromConfig');
      // Find channel config to extract defaultAgentId when not provided
      const cfg = this.getChannelConfig(channelId);
      const finalAgentId = agentId ?? cfg?.defaultAgentId ?? '';
      // MVP: chatId may be unknown at startup; routing layer will refine it on first inbound.
      const finalChatId = chatId ?? '';
      if (!finalAgentId) {
        logger.warn({ channelId, sessionId }, 'seedSessionFromConfig: no agentId resolvable, skipping');
        return;
      }
      setSessionMeta(sessionId, {
        agentId: finalAgentId,
        channelId,
        chatId: finalChatId,
        lastActiveAt: Date.now(),
      });
    },

    async ensureSession(channelId: ChannelId, chatId: ExternalChatId): Promise<SessionId> {
      logger.debug({ channelId, chatId }, '[SESSION-DIAG] ensureSession called');
      const existingId = mapGetSessionIdByChat(channelId, chatId);

      // State A — alive worker, reuse
      if (existingId && deps.workerPool.has(existingId)) {
        return existingId;
      }

      const cfg = this.getChannelConfig(channelId);
      if (!cfg || !cfg.defaultAgentId) {
        throw new Error(`ensureSession: channel ${channelId} not found or has no defaultAgentId`);
      }
      const agent = deps.agentRepo.get(cfg.defaultAgentId);
      if (!agent) {
        throw new Error(`ensureSession: agent ${cfg.defaultAgentId} not found`);
      }

      // State B — session row exists, worker dead → respawn
      if (existingId) {
        const existing = deps.sessionRepo.get(existingId);
        if (existing) {
          const { spawnAndCreate } = await import('./session-bridge.js');
          const result = await spawnAndCreate(
            existingId,
            agent,
            deps.sessionRepo,
            deps.workerPool,
            existing.piSessionPath,
          );
          if (!result) throw new Error(`ensureSession: respawn failed for ${existingId}`);
          setSessionMeta(existingId, {
            agentId: agent.id,
            channelId,
            chatId,
            lastActiveAt: Date.now(),
          });
          return existingId;
        }
      }

      // State B2 — post-restart fallback: map empty but channel config has currentSessionId
      // (private chat only: one bot → one user, so currentSessionId is unambiguous)
      logger.debug({ currentSessionId: cfg.currentSessionId }, '[SESSION-DIAG] B2 check');
      if (cfg.currentSessionId) {
        const savedSession = deps.sessionRepo.get(cfg.currentSessionId);
        if (savedSession) {
          const { spawnAndCreate } = await import('./session-bridge.js');
          const result = await spawnAndCreate(
            cfg.currentSessionId,
            agent,
            deps.sessionRepo,
            deps.workerPool,
            savedSession.piSessionPath,
          );
          if (result) {
            setSessionMeta(cfg.currentSessionId, {
              agentId: agent.id,
              channelId,
              chatId,
              lastActiveAt: Date.now(),
            });
            logger.info({ channelId, chatId, sessionId: cfg.currentSessionId }, 'ensureSession: restored from channel config');
            return cfg.currentSessionId;
          }
        }
      }

      // State C — new session
      const { spawnPlaceholder, spawnAndCreate } = await import('./session-bridge.js');
      const newSessionId = deps.sessionRepo.newSessionId();
      await spawnPlaceholder(newSessionId, agent, deps.workerPool);
      const result = await spawnAndCreate(newSessionId, agent, deps.sessionRepo, deps.workerPool);
      if (!result) throw new Error(`ensureSession: create failed for ${newSessionId}`);
      this.setCurrentSession(channelId, chatId, newSessionId);
      setSessionMeta(newSessionId, {
        agentId: agent.id,
        channelId,
        chatId,
        lastActiveAt: Date.now(),
      });
      return newSessionId;
    },

    async uploadAttachment(
      sessionId: SessionId,
      input: { bytes: Uint8Array; mimeType: string; filename?: string },
    ): Promise<{ id: string; mimeType: string; sizeBytes: number }> {
      const result = await deps.attachmentStore.upsert({
        sessionId,
        bytes: input.bytes,
        mimeType: input.mimeType,
        originalFilename: input.filename,
      });
      return { id: result.row.id, mimeType: result.row.mimeType, sizeBytes: result.row.sizeBytes };
    },

    async prompt(
      sessionId: SessionId,
      text: string,
    ): Promise<void> {
      await deps.promptWorker(sessionId, text);
    },

    async killWorker(sessionId: SessionId, reason: string): Promise<void> {
      await deps.killWorker(sessionId, reason);
    },

    async handleInbound(msg: InboundMessage): Promise<void> {
      const cfg = this.getChannelConfig(msg.channelId);
      if (!cfg) {
        return;
      }
      const adapter = deps.getAdapter(msg.channelType, msg.channelId);
      if (!adapter) {
        return;
      }
      logger.info({ channelId: msg.channelId, chatId: msg.chatId, channelType: msg.channelType, isGroup: msg.isGroup }, 'inbound routed to adapter');
      await deps.routeInbound(msg, {
        channelType: msg.channelType,
        adapter,
        agentRepo: deps.agentRepo,
        sessionRepo: deps.sessionRepo,
        workerPool: deps.workerPool,
        attachmentStore: deps.attachmentStore,
        host: this,
        getChannelConfig: (channelId) => this.getChannelConfig(channelId),
        setChannelCurrentSession: (channelId, chatId, sessionId) => {
          this.setCurrentSession(channelId, chatId, sessionId);
          // Persist current_session_id to DB so it survives restart.
          deps.db.exec(`UPDATE channels_${msg.channelType} SET current_session_id = '${sessionId}', updated_at = ${Date.now()} WHERE id = '${channelId}'`);
        },
        qqGroupNotified: deps.qqGroupNotified,
      });
    },

    parseCommand(text: string): ParsedCommand {
      const trimmed = text.trim();
      if (!trimmed.startsWith('/')) return { kind: 'text', text: trimmed };
      const space = trimmed.indexOf('\n') !== -1 ? trimmed.indexOf('\n') : trimmed.indexOf(' ');
      const cmdName = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
      const args = space === -1 ? '' : trimmed.slice(space + 1).trim();
      return { kind: 'command', name: cmdName, args };
    },

    async runBuiltinCommand(name: string, sessionId: SessionId, args: string): Promise<string | null> {
      return await deps.runBuiltin(name, sessionId, args);
    },

    onChannelLog(handler: ChannelLogHandler): void {
      logSubscribers.add(handler);
    },

    logEvent(event: Omit<ChannelLogEvent, 'timestamp'>): void {
      const fullEvent: ChannelLogEvent = { ...event, timestamp: new Date().toISOString() };
      logger.debug({ event: fullEvent }, 'channel log event');
      for (const h of logSubscribers) {
        try {
          h(fullEvent);
        } catch (err) {
          logger.warn({ err: String(err) }, 'channel log subscriber failed');
        }
      }
    },
  };

  // ── Reverse call handlers (worker → master RPC) ────────────────────────────
  deps.workerPool.registerReverseCallHandler('sendFileToUser', async (sessionId, args) => {
    const [sid, params] = args as [string, { filePath: string; fileName?: string; caption?: string }];
    const meta = getSessionMeta(sid);

    // IDE/Web session — no channel, return success (no-op)
    if (!meta) return { ok: true };

    // Look up channel config to get channelType
    const channelConfig = host.getChannelConfig(meta.channelId);
    const channelType = channelConfig?.type;
    if (!channelType) return { ok: true };

    const adapter = deps.getAdapter(channelType, meta.channelId);
    if (!adapter) return { ok: true };

    const target = { channelId: meta.channelId, chatId: meta.chatId };

    // Determine file extension from actual file path
    const ext = params.filePath.split('.').pop()?.toLowerCase() ?? '';
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext);

    // Construct final filename: fileName (without extension) + actual extension
    const baseName = params.fileName
      ? params.fileName.replace(/\.[^.]+$/, '')  // strip any extension from fileName
      : params.filePath.split(/[\/]/).pop()?.replace(/\.[^.]+$/, '') ?? 'file';
    const finalName = `${baseName}.${ext || 'bin'}`;

    if (isImage) {
      await adapter.sendImage(target, params.filePath, params.caption);
    } else {
      await adapter.sendFile(target, params.filePath, params.caption);
    }

    return { ok: true, fileName: finalName };
  });

  // ── server-only helpers (not part of ChannelHost interface) ───────────────────
  const helpers = {
    /** Get the hono router for a channel type (server mounts it under /api/im/<type>). */
    getRouterFor(type: ChannelType): Hono | undefined {
      return routersByType.get(type);
    },
    /** List all loaded channel types. */
    listLoadedTypes(): ChannelType[] {
      return Array.from(routersByType.keys());
    },
    /** Rebuild channel configs from DB at server startup. */
    seedChannelConfig(config: ChannelConfig): void {
      const s = stateFor(config.type);
      s.configs.set(config.id, config);
    },
    /** Get all channel configs for type. */
    listChannelConfigsByType(type: ChannelType): ChannelConfig[] {
      return Array.from(stateFor(type).configs.values()).map((cfg) => {
        const title = cfg.currentSessionId ? deps.sessionRepo.get(cfg.currentSessionId)?.title : undefined;
        return { ...cfg, currentSessionTitle: title } as ChannelConfig & { currentSessionTitle?: string };
      });
    },
    /** Remove session meta for a channel (called on channel stop). */
    removeSessionsForChannel(channelId: ChannelId): SessionId[] {
      // For MVP we just clear by channelId — the caller (channel-registry)
      // has the actual list; we delegate through session-channel-map.
      // The actual removal happens via session-channel-map.removeSessionsForChannel,
      // which is called from channel-registry directly when needed.
      // This helper is exposed for symmetry but the real impl is in session-channel-map.
      // For now return [] to satisfy the type — callers should use session-channel-map.
      void removeSessionMeta; // imported but used elsewhere
      return [];
    },
  };

  return { host, helpers };
}