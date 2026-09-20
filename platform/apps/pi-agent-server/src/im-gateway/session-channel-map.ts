/**
 * In-memory `Map<sessionId, SessionMeta>` for IM gateway.
 *
 * Tracks which chat each IM session is bound to so:
 *  - reply-sender can find the adapter by sessionId
 *  - server restart can rebuild from `channels_<type>.current_session_id`
 *
 * No database schema changes — sessions table untouched.
 */

import type {
  AgentId,
  ChannelId,
  ExternalChatId,
  SessionId,
  SessionMeta,
} from '@pi-agent-platform/channel-types';

/** Primary index: sessionId → SessionMeta. */
const bySessionId = new Map<SessionId, SessionMeta>();

/** Reverse index: chatKey → sessionId. */
const byChat = new Map<string, SessionId>();

const CHAT_KEY_SEP = '\u0001';

function chatKeyOf(channelId: ChannelId, chatId: ExternalChatId): string {
  return `${channelId}${CHAT_KEY_SEP}${chatId}`;
}

/** Set/update a session's metadata. */
export function setSessionMeta(sessionId: SessionId, meta: SessionMeta): void {
  // Remove old chat → session binding if it exists for this session
  const existing = bySessionId.get(sessionId);
  if (existing && (existing.channelId !== meta.channelId || existing.chatId !== meta.chatId)) {
    byChat.delete(chatKeyOf(existing.channelId, existing.chatId));
  }
  bySessionId.set(sessionId, meta);
  byChat.set(chatKeyOf(meta.channelId, meta.chatId), sessionId);
}

export function getSessionMeta(sessionId: SessionId): SessionMeta | null {
  return bySessionId.get(sessionId) ?? null;
}

export function getSessionIdByChat(channelId: ChannelId, chatId: ExternalChatId): SessionId | null {
  return byChat.get(chatKeyOf(channelId, chatId)) ?? null;
}

/** Touch the lastActiveAt timestamp. */
export function touchSession(sessionId: SessionId): void {
  const meta = bySessionId.get(sessionId);
  if (!meta) return;
  meta.lastActiveAt = Date.now();
}

/** Remove a session. */
export function removeSessionMeta(sessionId: SessionId): void {
  const meta = bySessionId.get(sessionId);
  if (!meta) return;
  byChat.delete(chatKeyOf(meta.channelId, meta.chatId));
  bySessionId.delete(sessionId);
}

/** Remove all sessions for a channel. */
export function removeSessionsForChannel(channelId: ChannelId): SessionId[] {
  const removed: SessionId[] = [];
  for (const [sid, meta] of bySessionId.entries()) {
    if (meta.channelId === channelId) {
      byChat.delete(chatKeyOf(meta.channelId, meta.chatId));
      bySessionId.delete(sid);
      removed.push(sid);
    }
  }
  return removed;
}

/** Clear all (server shutdown / tests). */
export function clearAll(): void {
  bySessionId.clear();
  byChat.clear();
}

/** Snapshot for debug endpoint. */
export function snapshot(): Array<[SessionId, SessionMeta]> {
  return Array.from(bySessionId.entries());
}

/** Size. */
export function size(): number {
  return bySessionId.size;
}

export type { AgentId, ChannelId, ExternalChatId, SessionId, SessionMeta };