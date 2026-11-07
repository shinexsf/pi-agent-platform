/**
 * Session binding for `sessionMode: 'reuse'` triggers.
 *
 * One place decides "which session does this trigger write into", shared by the
 * HTTP routes, the `trigger.*` capabilities and the dispatcher — so the console,
 * an agent and a fire all agree on the rule.
 *
 * Rules:
 *   - `sessionId` is only meaningful for `sessionMode: 'reuse'`; on `'new'` it is
 *     rejected rather than silently ignored (a silently dropped field is how you
 *     end up with two people who believe different things about where it writes).
 *   - omitted / empty → `null` = unbound: the first fire creates a session and
 *     pins it (reuse sticks afterwards).
 *   - a bound session MUST exist and MUST belong to the same agent. This is the
 *     own-scope boundary for the reuse target — the caller cannot aim a trigger
 *     at somebody else's conversation.
 */

import type { SessionRepo } from '../../repos/session.repo.js';
import type { TriggerSessionMode } from '@pi-agent-platform/shared-types';

export function sessionBindingError(message: string): Error {
  const e = new Error(message);
  e.name = 'ValidationError';
  return e;
}

/**
 * Normalize + validate a `sessionId` binding.
 * @returns the session id to store, or `null` for "create one on first fire".
 */
export function resolveSessionBinding(
  sessionRepo: SessionRepo,
  args: { agentId: string; sessionMode: TriggerSessionMode; sessionId?: string | null },
): string | null {
  const raw = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (!raw) return null;
  if (args.sessionMode !== 'reuse') {
    throw sessionBindingError(`sessionId 只能在会话模式为「复用同一会话」时指定（当前为 ${
      args.sessionMode === 'new' ? '每次新建会话' : args.sessionMode
    }）`);
  }
  const session = sessionRepo.get(raw);
  if (!session) throw sessionBindingError(`会话不存在：${raw}（可能已被删除）`);
  if (session.agentId !== args.agentId) {
    throw sessionBindingError(`会话 ${raw} 不属于该 agent（触发器只能复用自己 agent 的会话）`);
  }
  return raw;
}
