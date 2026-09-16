/**
 * SQLite schema via drizzle-orm.
 * Matches doc/architecture/current/pi-agent-server_db-schema.md.
 */

import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core';

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  workspacePath: text('workspace_path').notNull(),

  model: text('model').notNull(),
  thinkingLevel: text('thinking_level'),
  // All config (systemPrompt, tools, extensions, etc.) lives in config JSON.
  config: text('config'), // AgentConfig JSON

  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),

    model: text('model').notNull(),
    thinkingLevel: text('thinking_level'),
    // All config lives in config JSON (same structure as agents).
    config: text('config'),

    piSessionPath: text('pi_session_path').notNull(),

    status: text('status', { enum: ['active', 'archived'] }).notNull(),
    title: text('title'),

    createdAt: integer('created_at').notNull(),
    lastActiveAt: integer('last_active_at').notNull(),
  },
  (t) => ({
    agentIdIdx: index('idx_sessions_agent_id').on(t.agentId),
    statusIdx: index('idx_sessions_status').on(t.status),
    lastActiveIdx: index('idx_sessions_last_active_at').on(t.lastActiveAt),
  }),
);

/** Image attachments for user-pasted images (per-session, content-addressed by sha).
 *  Read-tool images do NOT live here — they're owned by the source filesystem path.
 *  PK = (session_id, sha): same content in different sessions may exist as multiple rows. */
export const attachments = sqliteTable(
  'attachments',
  {
    sessionId: text('session_id').notNull(),
    sha: text('sha').notNull(),
    /** Client-facing ID: "att_<base32-of-sha>" (lowercase, 17 chars total). */
    id: text('id').notNull(),
    mimeType: text('mime_type').notNull(),
    /** User-visible filename (preserved across re-upload for the same content). */
    originalFilename: text('original_filename').notNull().default(''),
    /** Actual filename on disk (uuid.ext). */
    filename: text('filename').notNull().default(''),
    /** Raw byte count (post base64 decode). Used for hard-cap validation. */
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sessionId, t.sha] }),
    sessionIdx: index('idx_attachments_session').on(t.sessionId),
  }),
);
