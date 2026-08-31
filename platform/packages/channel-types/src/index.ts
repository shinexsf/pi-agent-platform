/**
 * Node-target (backend) channel interfaces.
 *
 * Direction of calls:
 *   Host → Package: ChannelAdapter (host calls adapter methods to drive IM client)
 *   Package → Host: ChannelHost    (package calls host to route messages, persist state)
 *
 * ChannelPackage is the package entry (server calls register() once at startup).
 */

import type {
  AgentId,
  ChannelConfig,
  ChannelErrorHandler,
  ChannelId,
  ChannelLogEvent,
  ChannelLogHandler,
  ChannelMessageHandler,
  ChannelStatusHandler,
  ChannelStatusSnapshot,
  ChannelType,
  ExternalChatId,
  OutboundTarget,
  SchemaHints,
  SessionId,
} from './common.js';

// Re-export DOM types (frontend ChannelAdminPage + ChannelAdminHost) so consumers
// don't need a separate `/dom` subpath import.
export * from './dom.js';

// Re-export common types so consumers can `import { ChannelConfig } from '@pi-agent-platform/channel-types'`.
export * from './common.js';

// ──────────────────────────────────────────────────────────────────────────────
// ChannelAdapter — implemented by channel packages, called by host
// ──────────────────────────────────────────────────────────────────────────────

/**
 * One adapter instance per channel config row.
 * Adapter wraps the IM platform SDK and exposes a uniform interface to the host.
 */
export interface ChannelAdapter {
  /** Stable channel type (e.g. "wechat", "qq"). */
  readonly type: ChannelType;

  /** Start the adapter (connect to IM platform, start receiving messages). */
  start(): Promise<void>;

  /** Stop the adapter gracefully. */
  stop(): Promise<void>;

  /** Is the adapter currently connected? */
  isConnected(): boolean;

  /** Send a text reply. Returns platform message id. */
  sendText(target: OutboundTarget, text: string): Promise<string>;

  /** Send an image. Local file path on master. */
  sendImage(target: OutboundTarget, localPath: string, caption?: string): Promise<string>;

  /** Send a generic file. */
  sendFile(target: OutboundTarget, localPath: string, caption?: string): Promise<string>;

  /** Get the system-prompt context to inject for this channel's chats. */
  getSystemPromptContext(channelId: ChannelId, chatId: ExternalChatId): string;

  /** Register inbound message handler (host subscribes; called by adapter). */
  onMessage(handler: ChannelMessageHandler): void;

  /** Register error handler. */
  onError(handler: ChannelErrorHandler): void;

  /** Register status change handler. */
  onStatusChange(handler: ChannelStatusHandler): void;

  /** Get current status snapshot. */
  getStatus(): ChannelStatusSnapshot;
}

// ──────────────────────────────────────────────────────────────────────────────
// ChannelHost — implemented by main package, called by channel packages
// ──────────────────────────────────────────────────────────────────────────────

/** Session metadata tracked in memory by IM gateway. */
export interface SessionMeta {
  agentId: AgentId;
  channelId: ChannelId;
  chatId: ExternalChatId;
  /** ms epoch. */
  lastActiveAt: number;
}

/** Slash command parser result. */
export type ParsedCommand =
  | { kind: 'text'; text: string }
  | { kind: 'command'; name: string; args: string };

/**
 * Host interface exposed to channel packages.
 * 18 methods covering session, db, routing, event subscription.
 */
export interface ChannelHost {
  // ── Migration / Routes ──────────────────────────────────────────────────────

  /** Run a SQL migration (channel tables, indices). Versioned by name. */
  executeMigration(name: string, sql: string): void;

  /**
   * Run a SELECT and return rows as unknown[]. Channel packages use this for
   * startup seeding — e.g. read persisted `channels_<type>` rows into in-memory
   * ChannelConfig objects so the host knows about channels across server restarts.
   *
   * Returns raw row objects (column names = SELECT aliases).
   */
  query(sql: string): unknown[];

  /** Execute arbitrary write SQL (INSERT/UPDATE/DELETE). Used by channel
   * packages to persist ChannelConfig rows to their own tables. */
  exec(sql: string): void;

  /** Mount hono routes under `/api/im/<type>/*`. */
  registerRoutes(prefix: string, honoRouter: import('hono').Hono): void;

  // ── Channel config CRUD (persists to channels_<type> table) ─────────────────

  /** Get one channel config. */
  getChannelConfig(channelId: ChannelId): ChannelConfig | null;

  /** Get all channel configs of this type. */
  listChannelConfigs(): ChannelConfig[];

  /** Update channel config (full row). */
  updateChannelConfig(config: ChannelConfig): void;

  /** Create a new channel config. */
  createChannelConfig(config: Omit<ChannelConfig, 'id'> & { id?: ChannelId }): ChannelConfig;

  /** Delete a channel config. */
  deleteChannelConfig(channelId: ChannelId): void;

  // ── Session management (IM gateway handles mapping) ─────────────────────────

  /** Look up session meta by session id (in-memory Map<sessionId, SessionMeta>). */
  getSessionMeta(sessionId: SessionId): SessionMeta | null;

  /** Update lastActiveAt for a session (called on inbound message + worker event). */
  touchSession(sessionId: SessionId): void;

  /** Set the current session id for a chat. */
  setCurrentSession(channelId: ChannelId, chatId: ExternalChatId, sessionId: SessionId): void;

  /** Get the current session id for a chat. */
  getCurrentSession(channelId: ChannelId, chatId: ExternalChatId): SessionId | null;

  /** Rebuild a session-channel-map entry on server startup. Channel packages call
   * this from their register hook after migrations run, iterating over their
   * `channels_<type>` table rows where `current_session_id IS NOT NULL`.
   * `chatId` may be unknown at this point (channel packages that don't persist
   * chat-id will pass empty string). The map entry's lastActiveAt defaults to
   * `Date.now()` (fresh 30-min window per design D16). */
  seedSessionFromConfig(channelId: ChannelId, sessionId: SessionId, chatId?: ExternalChatId, agentId?: AgentId): void;

  // ── Worker pool access ───────────────────────────────────────────────────────

  /** Prompt a worker with a message (creates session if needed). */
  prompt(sessionId: SessionId, text: string, images?: Array<{ localPath: string; mimeType: string }>): Promise<void>;

  /** Kill a worker (reason for logging). */
  killWorker(sessionId: SessionId, reason: string): Promise<void>;

  // ── Inbound routing ───────────────────────────────────────────────────────────

  /** Hand an inbound IM message to the host's routing layer. Channel packages
   * call this from their SDK message handlers. The host will:
   *   1. Resolve channel config
   *   2. Look up / spawn session
   *   3. Forward to worker
   *   4. Stream reply back via adapter.sendText / sendImage
   *
   * MUST be called even for fast-fail cases (host handles them via config).
   * Returns when the message has been accepted (not necessarily replied to). */
  handleInbound(msg: import('./common.js').InboundMessage): Promise<void>;

  // ── Slash commands ──────────────────────────────────────────────────────────

  /** Parse a slash command. Returns command or plain text. */
  parseCommand(text: string): ParsedCommand;

  /** Execute a builtin slash command. Returns response text. */
  runBuiltinCommand(name: string, sessionId: SessionId, args: string): Promise<string | null>;

  // ── Events ──────────────────────────────────────────────────────────────────

  /** Subscribe to channel-level log events (for admin UI live feed). */
  onChannelLog(handler: ChannelLogHandler): void;

  /** Emit a log event to admin UI. */
  logEvent(event: Omit<ChannelLogEvent, 'timestamp'>): void;
}

// ──────────────────────────────────────────────────────────────────────────────
// ChannelPackage — package entry, server calls register() at startup
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Channel package entry. Server reads manifest.json, dynamically imports each
 * listed package, and calls register(host) once at startup.
 */
export interface ChannelPackage {
  /** Stable channel type (e.g. "wechat", "qq"). */
  readonly type: ChannelType;

  /** Human-readable name for admin UI. */
  readonly displayName: string;

  /** Schema hints for admin UI form generation. */
  readonly schemaHints: SchemaHints;

  /** Register with the host: declare routes, migrations, channel start/stop hooks. */
  register(host: ChannelHost): void | Promise<void>;
}