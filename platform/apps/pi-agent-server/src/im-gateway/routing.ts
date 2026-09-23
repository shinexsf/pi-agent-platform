/**
 * routing — handles inbound IM messages end-to-end:
 *
 *   1. Resolve channel config (and per-chat binding if any)
 *   2. Look up session id for chat (state A / B / C)
 *   3. Spawn / respawn / reuse worker as appropriate
 *   4. Update SessionMeta in memory
 *   5. Parse slash commands, dispatch builtin or forward to worker
 *   6. QQ group messages: fast-fail (one-time error reply per group)
 *
 * The host adapter calls `routeAndSpawn(inbound)` once per inbound message.
 */

import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelHost,
  InboundMessage,
  OutboundTarget,
  SessionId,
} from '@pi-agent-platform/channel-types';
import type { AgentRepo } from '../repos/agent.repo.js';
import type { SessionRepo } from '../repos/session.repo.js';
import type { WorkerPool } from '../worker-pool.js';
import { logger } from './logger.js';
import {
  getSessionIdByChat,
  setSessionMeta,
  touchSession,
} from './session-channel-map.js';
import { spawnAndCreate, spawnPlaceholder, type AgentLike } from './session-bridge.js';
import { runBuiltinCommand } from './slash-commands.js';
import { onMessageEnd, onMessageUpdate } from './reply-sender.js';
import { resolvePrompt } from '../prompt-resolver.js';
import type { AttachmentStore } from '../services/attachment-store.js';

export interface RouteContext {
  channelType: string;
  adapter: ChannelAdapter;
  agentRepo: AgentRepo;
  sessionRepo: SessionRepo;
  workerPool: WorkerPool;
  attachmentStore: AttachmentStore;
  /** Host reference for setCurrentSession / getCurrentSession / etc. */
  host: ChannelHost;
  /** Channel config getter (channel packages implement). */
  getChannelConfig: (channelId: string) => ChannelConfig | null;
  /** Channel config updater (current_session_id persistence). */
  setChannelCurrentSession: (channelId: string, chatId: string, sessionId: SessionId) => void;
  /** QQ group notified set (per-process, in-memory). */
  qqGroupNotified: Set<string>;
}

export interface RouteResult {
  handled: 'agent' | 'command' | 'fast-fail' | 'no-channel' | 'no-agent';
  sessionId?: SessionId;
  reply?: string;
}

/** Main entry — called by host per inbound message. */
export async function routeAndSpawn(msg: InboundMessage, ctx: RouteContext): Promise<RouteResult> {
  // ── 1. Channel config ────────────────────────────────────────────────────────
  const channel = ctx.getChannelConfig(msg.channelId);
  if (!channel || !channel.enabled) {
    logger.warn({ channelId: msg.channelId }, 'inbound message for unknown/disabled channel');
    return { handled: 'no-channel' };
  }
  if (!channel.defaultAgentId) {
    logger.warn({ channelId: msg.channelId }, 'channel has no defaultAgentId');
    return { handled: 'no-agent' };
  }
  const agent = ctx.agentRepo.get(channel.defaultAgentId);
  if (!agent) {
    logger.warn({ channelId: msg.channelId, agentId: channel.defaultAgentId }, 'defaultAgentId not found');
    return { handled: 'no-agent' };
  }

  // ── 2. QQ group fast-fail ────────────────────────────────────────────────────
  if (msg.isGroup) {
    return await handleGroupFastFail(msg, ctx);
  }

  // ── 3. Slash command parsing ─────────────────────────────────────────────────
  const trimmed = msg.text.trim();
  if (trimmed.startsWith('/')) {
    const space = trimmed.indexOf(' ');
    const cmdName = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
    const args = space === -1 ? '' : trimmed.slice(space + 1).trim();
    const ensured = await ensureSession(msg, channel, agent, ctx);
    if (!ensured) return { handled: 'no-agent' };
    touchSession(ensured);
    const reply = await runBuiltinCommand(cmdName, {
      sessionId: ensured,
      args,
      ctx: {
        getSessionSummary: async () => {
          const s = ctx.sessionRepo.get(ensured);
          return {
            model: s?.model ?? agent.model,
            thinkingLevel: s?.thinkingLevel ?? null,
            title: s?.title ?? null,
          };
        },
        setModel: async (model) => {
          await ctx.workerPool.call(ensured, 'setModel', [model]);
        },
        setThinkingLevel: async (level) => {
          await ctx.workerPool.call(ensured, 'setThinkingLevel', [level]);
        },
        compact: async () => {
          await ctx.workerPool.call(ensured, 'compact', []);
        },
        startNewSession: async () => {
          // /new — same flow as a brand-new session (ensureSession State C):
          // spawn the worker FIRST so createSession returns the real piSessionPath,
          // then persist the row via spawnAndCreate → createFromAgent(path).
          // NEVER pre-create the row with piSessionPath '' — history
          // (GET /:id/messages) reads that file directly and would return empty.
          const oldSessionId = ensured;
          const newSessionId = ctx.sessionRepo.newSessionId();
          await ctx.workerPool.kill(oldSessionId, 'new-command');
          const result = await spawnAndCreate(newSessionId, agent, ctx.sessionRepo, ctx.workerPool);
          if (!result) {
            throw new Error('failed to create new session worker');
          }
          ctx.setChannelCurrentSession(channel.id, msg.chatId, newSessionId);
          setSessionMeta(newSessionId, {
            agentId: agent.id,
            channelId: channel.id,
            chatId: msg.chatId,
            lastActiveAt: Date.now(),
          });
          return { sessionId: newSessionId };
        },
      },
    });
    if (reply !== null) {
      await ctx.adapter.sendText({ channelId: msg.channelId, chatId: msg.chatId }, reply);
      return { handled: 'command', sessionId: ensured, reply };
    }
    // Not a builtin → fallthrough to agent prompt
  }

  // ── 4. Three-state session lifecycle ─────────────────────────────────────────
  const ensured = await ensureSession(msg, channel, agent, ctx);
  if (!ensured) return { handled: 'no-agent' };
  touchSession(ensured);
  subscribeReplySender(ensured, ctx);

  // ── 5. Forward prompt to worker ──────────────────────────────────────────────
  // Resolve attachment placeholders so worker receives promptOptions.attachments
  logger.debug({ sessionId: ensured }, '[ROUTING-DIAG] resolvePrompt');
  const resolved = await resolvePrompt(ensured, msg.text, {
    allowSteer: true,
  }, {
    sessionRepo: ctx.sessionRepo,
    agentRepo: ctx.agentRepo,
    attachmentStore: ctx.attachmentStore,
  });

  if (resolved.intercepted) {
    await ctx.adapter.sendText(
      { channelId: msg.channelId, chatId: msg.chatId },
      resolved.intercepted.content,
    );
    return { handled: 'command', sessionId: ensured, reply: resolved.intercepted.content };
  }

  logger.debug(
    {
      sessionId: ensured,
      textLen: resolved.message.length,
      attachments: resolved.promptOptions.attachments?.length ?? 0,
    },
    '[ROUTING-DIAG] prompt',
  );
  try {
    await ctx.workerPool.call(ensured, 'prompt', [resolved.message, resolved.promptOptions]);
  } catch (err) {
    logger.error({ err: String(err), sessionId: ensured }, 'prompt failed');
    await ctx.adapter.sendText(
      { channelId: msg.channelId, chatId: msg.chatId },
      `处理失败:${String(err).slice(0, 200)}`,
    );
    return { handled: 'agent', sessionId: ensured };
  }

  return { handled: 'agent', sessionId: ensured };
}

async function ensureSession(
  msg: InboundMessage,
  channel: ChannelConfig,
  agent: AgentLike,
  ctx: RouteContext,
): Promise<SessionId | null> {
  const existingId = getSessionIdByChat(msg.channelId, msg.chatId);

  // State A — alive worker, reuse
  if (existingId && ctx.workerPool.has(existingId)) {
    return existingId;
  }

  // State B — session row exists, worker dead → respawn
  if (existingId) {
    const existing = ctx.sessionRepo.get(existingId);
    if (existing) {
      const result = await spawnAndCreate(
        existingId,
        agent,
        ctx.sessionRepo,
        ctx.workerPool,
        existing.piSessionPath,
      );
      if (!result) return null;
      setSessionMeta(existingId, {
        agentId: agent.id,
        channelId: msg.channelId,
        chatId: msg.chatId,
        lastActiveAt: Date.now(),
      });
      return existingId;
    }
  }

  // State B2 — post-restart fallback: map empty but channel config has currentSessionId
  // (private chat only: one bot → one user, so currentSessionId is unambiguous)
  if (channel.currentSessionId) {
    const saved = ctx.sessionRepo.get(channel.currentSessionId);
    if (saved) {
      const result = await spawnAndCreate(
        channel.currentSessionId,
        agent,
        ctx.sessionRepo,
        ctx.workerPool,
        saved.piSessionPath,
      );
      if (result) {
        setSessionMeta(channel.currentSessionId, {
          agentId: agent.id,
          channelId: msg.channelId,
          chatId: msg.chatId,
          lastActiveAt: Date.now(),
        });
        logger.info({ channelId: msg.channelId, chatId: msg.chatId, sessionId: channel.currentSessionId }, 'ensureSession: restored from channel config');
        return channel.currentSessionId;
      }
    }
  }

  // State C — new session
  const newSessionId = ctx.sessionRepo.newSessionId();
  // Step 1: spawn placeholder (so worker is alive and pi_session_path is ready)
  await spawnPlaceholder(newSessionId, agent, ctx.workerPool);
  // Step 2: persist session row
  const result = await spawnAndCreate(newSessionId, agent, ctx.sessionRepo, ctx.workerPool);
  if (!result) {
    // spawnAndCreate already killed the worker; nothing more to do
    return null;
  }
  // Step 3: write current_session_id to channel config
  ctx.setChannelCurrentSession(channel.id, msg.chatId, newSessionId);
  setSessionMeta(newSessionId, {
    agentId: agent.id,
    channelId: msg.channelId,
    chatId: msg.chatId,
    lastActiveAt: Date.now(),
  });
  return newSessionId;
}

/** Per-session unsubscribe functions for our reply-sender subscription.
 * When the worker dies (idle scanner / /new), the old listener is gone with
 * the worker entry; when a new worker is spawned we need to subscribe again.
 * Track the unsubscribe fn so we can drop the previous listener cleanly. */
const replySenders = new Map<SessionId, () => void>();

/**
 * Subscribe to worker events for an IM session. Hands off to reply-sender which
 * buffers message_update chunks and dispatches via adapter.sendText on message_end.
 *
 * Re-subscribes if the previous worker was killed (idle scanner) and a new
 * worker has just been spawned — necessary for "resume after idle" to work.
 */
function subscribeReplySender(sessionId: SessionId, ctx: RouteContext): void {
  if (!ctx.workerPool.has(sessionId)) {
    // Worker died between inbound and subscribe — try again shortly. ensureSession
    // (called earlier in routeAndSpawn) should have respawned it; retry loop
    // covers the race.
    setTimeout(() => subscribeReplySender(sessionId, ctx), 50);
    return;
  }
  // Drop any previous subscription: when the worker died, the old listener is
  // gone with it, but if a new worker reused the same sessionId before the
  // worker entry fully cleared, we still want to bind to the live worker entry.
  const prev = replySenders.get(sessionId);
  if (prev) {
    prev();
    replySenders.delete(sessionId);
  }
  const unsubscribe = ctx.workerPool.subscribe(sessionId, (event) => {
    if (event.kind !== 'event') return;
    const inner = (event as { event?: string }).event;
    const dto = (event as { data?: { messageId?: string; parentId?: string; content?: string; role?: string } }).data;
    if (inner === 'message_update' && dto?.messageId) {
      if (dto.role && dto.role !== 'assistant') {
            return;
      }
      onMessageUpdate(sessionId, dto.messageId, dto.parentId ?? null, dto.content ?? '');
      touchSession(sessionId);
    } else if (inner === 'message_end' && dto?.messageId) {
      if (dto.role && dto.role !== 'assistant') {
            return;
      }
      void onMessageEnd(sessionId, dto.messageId, ctx.adapter);
      touchSession(sessionId);
    } else if (inner === 'agent_end') {
      // Last event of the prompt cycle. No-op here; reply already dispatched above.
    }
  });
  replySenders.set(sessionId, unsubscribe);
  logger.info({ sessionId }, 'reply-sender subscribed to worker');
}

async function handleGroupFastFail(msg: InboundMessage, ctx: RouteContext): Promise<RouteResult> {
  const groupKey = `${msg.channelId}\u0001${msg.chatId}`;
  if (ctx.qqGroupNotified.has(groupKey)) {
    logger.debug({ groupKey }, 'qq group fast-fail: silent (already notified)');
    return { handled: 'fast-fail' };
  }
  ctx.qqGroupNotified.add(groupKey);
  logger.info({ groupKey }, 'qq group fast-fail: sending one-time reply');
  try {
    await ctx.adapter.sendText(
      { channelId: msg.channelId, chatId: msg.chatId } satisfies OutboundTarget,
      '群聊功能暂未支持，请私聊机器人。',
    );
  } catch (err) {
    logger.warn({ err: String(err), groupKey }, 'qq group fast-fail sendText failed');
  }
  return { handled: 'fast-fail' };
}