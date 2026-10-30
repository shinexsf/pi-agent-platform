/**
 * reply-sender — accumulates worker `message_update` events and dispatches
 * the final text via `adapter.sendText` on `message_end`.
 *
 * Worker model:
 *   - `agent_end` event has an EMPTY delta (sentinel only)
 *   - real text is emitted as `message_update` chunks
 *   - `message_end` carries the final message id
 *
 * Ordering for multi-message queues:
 *   - we use `messageId.parentId` to associate the reply with the user prompt
 *   - one user prompt → one assistant message
 *
 * MVP scope: text-only (no images / files via tool — `sendFileToUser` deferred).
 */

import type {
  ChannelAdapter,
  ChannelId,
  ExternalChatId,
  SessionId,
} from '@pi-agent-platform/channel-types';
import { getSessionMeta } from './session-channel-map.js';
import { logger } from './logger.js';

interface PendingMessage {
  messageId: string;
  parentId: string | null;
  text: string;
  done: boolean;
}

const pendingBySession = new Map<SessionId, PendingMessage>();

/** Record a `message_update` chunk for a session.
 *
 * NOTE: The SDK worker emits *accumulated* content snapshots (not text deltas).
 * Every `message_update` carries the full text seen so far. If we append here,
 * we get duplicates. So we just replace `p.text` with the latest snapshot —
 * it's already a complete picture up to this point. */
export function onMessageUpdate(
  sessionId: SessionId,
  messageId: string,
  parentId: string | null,
  snapshotText: string,
): void {
  let p = pendingBySession.get(sessionId);
  if (!p || p.messageId !== messageId) {
    p = { messageId, parentId, text: '', done: false };
    pendingBySession.set(sessionId, p);
  }
  p.text = snapshotText;
}

/** Handle `message_end` — dispatch the final text via adapter.
 *
 * `hasToolCalls` marks an INTERMEDIATE assistant message (text + toolCall in
 * one message — pi emits the pre-tool narration as its own assistant message).
 * Sending those made the IM user see a stray fragment (e.g. "ok") before the
 * final answer — and with a final answer that is also short, two "ok"s.
 * Only pure-text assistant messages are dispatched.
 *
 * The pending entry is claimed (done + deleted) SYNCHRONOUSLY before the
 * first await: a duplicate `message_end` (redelivered inbound / double
 * subscription) used to pass the `messageId` check while the first send was
 * still in flight, dispatching the same text twice. */
export async function onMessageEnd(
  sessionId: SessionId,
  messageId: string,
  adapter: ChannelAdapter,
  hasToolCalls = false,
): Promise<void> {
  logger.info({ sessionId, messageId, adapterType: adapter.type, hasToolCalls }, 'reply-sender: worker message_end received');
  const p = pendingBySession.get(sessionId);
  if (!p || p.messageId !== messageId || p.done) {
    return;
  }
  p.done = true;
  pendingBySession.delete(sessionId);
  if (hasToolCalls) {
    // Intermediate message — the turn continues; the FINAL message_end
    // (pure text, after tool results) is the one that reaches the user.
    return;
  }
  const text = p.text.trim();
  if (!text) {
    return;
  }
  const meta = getSessionMeta(sessionId);
  if (!meta) {
    return;
  }
  logger.info({ sessionId, channelId: meta.channelId, chatId: meta.chatId, length: text.length }, 'reply-sender: dispatching text');
  try {
    await adapter.sendText(
      { channelId: meta.channelId, chatId: meta.chatId },
      text,
    );
  } catch (err) {
    logger.error({ err: String(err), sessionId, channelId: meta.channelId, chatId: meta.chatId }, 'reply-sender: send failed');
  }
}

/** Cleanup on worker death. */
export function clearSession(sessionId: SessionId): void {
  pendingBySession.delete(sessionId);
}

/** Snapshot for debug endpoint. */
export function snapshot(): Array<[SessionId, PendingMessage]> {
  return Array.from(pendingBySession.entries());
}

export type { ChannelAdapter, ChannelId, ExternalChatId, SessionId };