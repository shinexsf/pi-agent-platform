/**
 * im-gateway/index.ts — module entry point.
 *
 * Boots the IM gateway subsystem:
 *   1. Creates the ChannelHost impl
 *   2. Loads all channels from manifest.json (dynamic import)
 *   3. For each loaded channel type, wires inbound messages into routing.ts
 *   4. Mounts /api/im/* routes (manifest, health, channels, debug) + per-type routers
 *
 * Returns the im-gateway handle so server/index.ts can gracefully shutdown.
 */

import type Database from 'better-sqlite3';
import type { AgentRepo } from '../repos/agent.repo.js';
import type { SessionRepo } from '../repos/session.repo.js';
import type { WorkerPool } from '../worker-pool.js';
import { logger } from './logger.js';
import { createChannelHostImpl } from './channel-host-impl.js';
import { loadChannels } from './channel-loader.js';
import { createImGatewayRouter } from './routes/im-gateway.js';
import { registerChannel, listChannels, clearAll as clearRegistry } from './channel-registry.js';
import {
  setSessionMeta,
  getSessionMeta,
  removeSessionsForChannel as mapRemoveForChannel,
  size as sessionMapSize,
} from './session-channel-map.js';
import { routeAndSpawn, type RouteContext } from './routing.js';
import { onMessageEnd, onMessageUpdate } from './reply-sender.js';
import { runBuiltinCommand } from './slash-commands.js';

// onMessageEnd/onMessageUpdate are imported but used only transitively (via routing.ts).
void onMessageEnd;
void onMessageUpdate;

export interface ImGatewayDeps {
  agentRepo: AgentRepo;
  sessionRepo: SessionRepo;
  workerPool: WorkerPool;
  /** Raw better-sqlite3 handle for executeMigration(). */
  rawDb: Database.Database;
  /** Attachment store for IM adapter uploads. */
  attachmentStore: import('../services/attachment-store.js').AttachmentStore;
}

export interface ImGatewayHandle {
  /** The /api/im/* router — caller must mount this on the Hono instance BEFORE serve(). */
  imRouter: import('hono').Hono;
  /** Number of channel packages loaded. */
  loadedCount: number;
  /** Loaded channel types. */
  loadedTypes: string[];
  /** Graceful shutdown — stops adapters, scanner, and frees in-memory state. */
  shutdown(): Promise<void>;
}

export async function startImGateway(deps: ImGatewayDeps): Promise<ImGatewayHandle> {
  logger.info('starting im-gateway');

  // QQ group fast-fail notified set (per-process)
  const qqGroupNotified = new Set<string>();

  // 1. Build host
  const { host, helpers } = createChannelHostImpl({
    agentExists: (id) => !!deps.agentRepo.get(id),
    promptWorker: async (sessionId, text) => {
      await deps.workerPool.call(sessionId, 'prompt', [text]);
    },
    attachmentStore: deps.attachmentStore,
    killWorker: async (sessionId, reason) => {
      await deps.workerPool.kill(sessionId, reason);
    },
    runBuiltin: async (name, sessionId, args) => {
      return await runBuiltinCommand(name, {
        sessionId,
        args,
        ctx: {
          getSessionSummary: async () => {
            const s = deps.sessionRepo.get(sessionId);
            return {
              model: s?.model ?? '',
              thinkingLevel: s?.thinkingLevel ?? null,
              title: s?.title ?? null,
            };
          },
          setModel: async (model) => {
            await deps.workerPool.call(sessionId, 'setModel', [model]);
          },
          setThinkingLevel: async (level) => {
            await deps.workerPool.call(sessionId, 'setThinkingLevel', [level]);
          },
          compact: async () => {
            await deps.workerPool.call(sessionId, 'compact', []);
          },
          startNewSession: async () => {
            // /new — kill old worker + create new session id
            const oldSessionId = sessionId;
            const newSessionId = deps.sessionRepo.newSessionId();
            await deps.workerPool.kill(oldSessionId, 'new-command');
            deps.sessionRepo.createFromAgent({
              sessionId: newSessionId,
              agentId: deps.sessionRepo.get(oldSessionId)?.agentId ?? '',
              piSessionPath: '', // will be set by spawnAndCreate
            });
            return { sessionId: newSessionId };
          },
        },
      });
    },
    db: {
      exec: (sql) => deps.rawDb.exec(sql),
      prepare: (sql) => ({ all: () => deps.rawDb.prepare(sql).all() }),
    },
    // Inbound routing: forward SDK-received messages to session bridge.
    routeInbound: async (msg, ctx) => {
      await routeAndSpawn(msg, ctx);
    },
    // Adapter lookup so handleInbound can find the active adapter for replies.
    getAdapter: (_channelType, channelId) => {
      return listChannels().find((c) => c.channelId === channelId)?.adapter ?? null;
    },
    agentRepo: deps.agentRepo,
    sessionRepo: deps.sessionRepo,
    workerPool: deps.workerPool,
    qqGroupNotified,
  });

  // 2. Load channels
  const loaded = await loadChannels(host);
  logger.info({ count: loaded.length, types: loaded.map((l) => l.type) }, 'channels loaded');

  // 3. Wire each adapter into routing + reply-sender
  // Channel packages are responsible for starting their own adapters (onChannelStart).
  // We don't auto-start — that's a per-channel decision (user creates channel, then starts).
  // Instead we listen for adapter registration via the registry.

  // (Worker event subscription happens per-session inside routing.ts subscribeReplySender.)

  // 4. Build /api/im/* router — caller (server/index.ts) mounts it BEFORE
  // serve() to avoid Hono's "matcher already built" error.
  const imRouter = createImGatewayRouter({ host, helpers, sessionRepo: deps.sessionRepo, qqGroupNotified });

  logger.info({ sessionMapSize: sessionMapSize() }, 'im-gateway ready');

  return {
    /** The /api/im/* router — mount this on your Hono instance BEFORE serve(). */
    imRouter,
    /** Number of channel packages loaded. */
    loadedCount: loaded.length,
    /** Loaded channel types. */
    loadedTypes: loaded.map((l) => l.type),
    async shutdown() {
      logger.info('im-gateway shutting down');
      clearRegistry();
    },
  };
}

// Export internals for testing / routes/im-gateway.ts
export {
  setSessionMeta,
  registerChannel,
  runBuiltinCommand,
  mapRemoveForChannel,
};
export type { RouteContext };