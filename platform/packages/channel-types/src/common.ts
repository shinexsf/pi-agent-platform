/**
 * Shared types between backend (Node) and frontend (DOM) channel types.
 * Pure type module — no runtime dependencies.
 */

/** Stable identifier (e.g. `"wechat"`, `"qq"`). */
export type ChannelType = string;

/** Stable identifier for a configured channel instance (DB row id). */
export type ChannelId = string;

/** External chat identifier from the IM platform (openid, user id, etc). */
export type ExternalChatId = string;

/** pi session id (UUID). */
export type SessionId = string;

/** pi agent id. */
export type AgentId = string;

/** Inbound message metadata (from IM platform → adapter → host). */
export interface InboundMessage {
  channelId: ChannelId;
  channelType: ChannelType;
  /** External chat identifier. For groups: groupOpenid. For p2p: openid. */
  chatId: ExternalChatId;
  /** Display name for logging / debugging. */
  chatName?: string;
  /** Whether this is a group chat (true) or 1-on-1 (false). */
  isGroup: boolean;
  /** Sender user id (only meaningful for groups). */
  senderId?: ExternalChatId;
  /** Sender display name. */
  senderName?: string;
  /** Plain text body. Image-only messages have empty text.
   * Attachments are downloaded by the adapter, persisted via host.uploadAttachment(),
   * and referenced as `[pi-attachment:att_xxx]` placeholders in this text. */
  text: string;
  /** Platform-side message id (for replies / quoting). */
  platformMessageId?: string;
  /** ISO timestamp. */
  timestamp: string;
}

/** Outbound message envelope (host → adapter → IM platform). */
export interface OutboundTarget {
  channelId: ChannelId;
  chatId: ExternalChatId;
  /** Platform message id to reply to (if any). */
  replyToPlatformMessageId?: string;
}

/** Channel config row (DB-backed). */
export interface ChannelConfig {
  id: ChannelId;
  type: ChannelType;
  displayName: string;
  enabled: boolean;
  /** Default agent id when no per-chat override (MVP: only field used). */
  defaultAgentId?: AgentId;
  /** pi session id currently bound to this channel's primary chat (MVP: p2p only). */
  currentSessionId?: SessionId;
  /** Free-form config blob (channel-specific). */
  extra?: Record<string, unknown>;
  /** Created/updated timestamps (managed by channel package's DB schema). */
  createdAt?: number;
  updatedAt?: number;
}

/** Channel runtime status. */
export type ChannelStatus =
  | 'disabled'
  | 'starting'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'stopped';

/** Channel status snapshot exposed by the host. */
export interface ChannelStatusSnapshot {
  channelId: ChannelId;
  channelType: ChannelType;
  status: ChannelStatus;
  /** Last error message, if any. */
  error?: string;
  /** ISO timestamp of last status change. */
  since: string;
  /** Adapter-side metrics (kept generic — channel packages decide). */
  metrics?: Record<string, number | string | boolean>;
}

/** Structured event for host log (used by adapter to surface auth QR, errors, etc.). */
export interface ChannelLogEvent {
  channelId: ChannelId;
  channelType: ChannelType;
  /** Event kind: 'info' | 'warn' | 'error' | 'qr-url' | 'auth-success' | 'message-sent' | etc. */
  kind: string;
  message?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

/** Event listener functions. */
export type ChannelMessageHandler = (msg: InboundMessage) => void | Promise<void>;
export type ChannelErrorHandler = (channelId: ChannelId, err: Error) => void;
export type ChannelStatusHandler = (snapshot: ChannelStatusSnapshot) => void;
export type ChannelLogHandler = (event: ChannelLogEvent) => void;

/** Schema hints for admin UI (admin pages use these to generate forms). */
export interface SchemaHints {
  /** Config fields with metadata (used by admin UI to render forms). */
  configFields: Array<{
    key: string;
    label: string;
    type: 'text' | 'password' | 'select' | 'checkbox' | 'number' | 'path';
    required?: boolean;
    options?: Array<{ value: string; label: string }>;
    placeholder?: string;
    help?: string;
  }>;
}