/**
 * Internal types for the IM gateway module.
 *
 * These are NOT part of the channel-types package — they're server-internal
 * structures used to wire adapters, routing, and persistence.
 */

import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelId,
  ChannelStatusSnapshot,
  ChannelType,
  ExternalChatId,
  SessionId,
} from '@pi-agent-platform/channel-types';

export type {
  ChannelAdapter,
  ChannelConfig,
  ChannelId,
  ChannelStatusSnapshot,
  ChannelType,
  ExternalChatId,
  SessionId,
};

/** Adapter instance with the channel config it serves. */
export interface RegisteredChannel {
  channelId: ChannelId;
  channelType: ChannelType;
  config: ChannelConfig;
  adapter: ChannelAdapter;
  status: ChannelStatusSnapshot;
  /** Most recent error, if any (cleared on reconnect). */
  lastError?: string;
}

/** Key for chat-level session binding (per chat within a channel). */
export interface ChatKey {
  channelId: ChannelId;
  chatId: ExternalChatId;
}

/** Builtin slash command identifiers (kept server-side, not channel-specific). */
export type BuiltinCommand = 'help' | 'new' | 'session' | 'model' | 'think' | 'compact' | 'name' | 'hotkeys';

/** A slash command declared by a channel package (extensible). */
export interface ChannelCommand {
  name: string;
  description: string;
  /** Optional handler — if absent, gateway falls through to builtin or worker. */
  handler?: (sessionId: SessionId, args: string) => Promise<string | null>;
}