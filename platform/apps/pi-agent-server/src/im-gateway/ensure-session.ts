/**
 * ensureSessionShared — THE single chat→session binding flow (task 2.6,
 * core-session-refactor).
 *
 * States (identical in both former implementations):
 *   A  — alive worker for this chat → reuse
 *   B  — map id has a row, worker dead → respawn via registry.getOrCreate
 *   B2 — post-restart: map empty but channel config has currentSessionId
 *        (private chat only: one bot → one user → unambiguous)
 *   C  — new session: createFromAgent (placeholder) + getOrCreate (persist row),
 *        then persist the chat→session binding into the channel config
 *
 * Consumers:
 *   - im-gateway/routing.ts     (inbound messages; failure → null)
 *   - channel-host-impl.ts      (host.ensureSession from channel packages;
 *                                failure → throw)
 * Each wrapper keeps its own agent-resolution/error style and wires its own
 * channel-config persistence — NOTE the merged State C always persists
 * memory + DB (routing's semantics). The former channel-host version only
 * updated memory, so attachment-flow sessions lost their binding on restart
 * (B2 broken) — that divergence is exactly what this merge fixes.
 */

import type { SessionId } from '@pi-agent-platform/channel-types';
import type { AgentRepo } from '../repos/agent.repo.js';
import type { SessionRepo } from '../repos/session.repo.js';
import type { WorkerPool } from '../worker-pool.js';
import { sessionRegistry, type AgentLike } from '../services/session.js';
import { getSessionIdByChat, setSessionMeta } from './session-channel-map.js';
import { logger } from './logger.js';

export interface EnsureSessionDeps {
  agentRepo: AgentRepo;
  sessionRepo: SessionRepo;
  workerPool: WorkerPool;
  /** B2: currentSessionId from the channel config (survives restart). */
  getChannelCurrentSessionId(channelId: string): string | undefined;
  /** Persist the chat→session binding into the channel config (memory + DB). */
  persistCurrentSession(channelId: string, chatId: string, sessionId: SessionId): void;
}

export type EnsureSessionOutcome =
  | { ok: true; sessionId: SessionId }
  | { ok: false; stage: 'respawn' | 'create'; sessionId: SessionId };

export async function ensureSessionShared(
  channelId: string,
  chatId: string,
  agent: AgentLike,
  deps: EnsureSessionDeps,
): Promise<EnsureSessionOutcome> {
  const existingId = getSessionIdByChat(channelId, chatId);

  // State A — alive worker, reuse
  if (existingId && deps.workerPool.has(existingId)) {
    return { ok: true, sessionId: existingId };
  }

  // State B — session row exists, worker dead → respawn
  if (existingId) {
    const existing = deps.sessionRepo.get(existingId);
    if (existing) {
      const revived = await sessionRegistry().getOrCreate(existingId, agent);
      if (!revived) return { ok: false, stage: 'respawn', sessionId: existingId };
      setSessionMeta(existingId, {
        agentId: agent.id,
        channelId,
        chatId,
        lastActiveAt: Date.now(),
      });
      return { ok: true, sessionId: existingId };
    }
  }

  // State B2 — post-restart fallback: map empty but channel config has currentSessionId
  // (private chat only: one bot → one user, so currentSessionId is unambiguous)
  const b2Id = deps.getChannelCurrentSessionId(channelId);
  if (b2Id) {
    const saved = deps.sessionRepo.get(b2Id);
    if (saved) {
      const revived = await sessionRegistry().getOrCreate(b2Id, agent);
      if (revived) {
        setSessionMeta(b2Id, {
          agentId: agent.id,
          channelId,
          chatId,
          lastActiveAt: Date.now(),
        });
        logger.info({ channelId, chatId, sessionId: b2Id }, 'ensureSession: restored from channel config');
        return { ok: true, sessionId: b2Id };
      }
    }
  }

  // State C — new session (createFromAgent = id + placeholder spawn; getOrCreate
  // persists the row — same sequence as the old spawnPlaceholder + spawnAndCreate pair)
  const fresh = await sessionRegistry().createFromAgent(agent.id);
  const persisted = await sessionRegistry().getOrCreate(fresh.id, agent);
  if (!persisted) return { ok: false, stage: 'create', sessionId: fresh.id };
  // Persist BEFORE returning: B2 revival after restart depends on it.
  deps.persistCurrentSession(channelId, chatId, fresh.id);
  setSessionMeta(fresh.id, {
    agentId: agent.id,
    channelId,
    chatId,
    lastActiveAt: Date.now(),
  });
  return { ok: true, sessionId: fresh.id };
}
