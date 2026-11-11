/**
 * SQLite schema via drizzle-orm.
 * Matches doc/architecture/pi-agent-server_db-schema.md.
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

/** Saved agent configuration templates (snapshot of the seven AgentConfig fields).
 *  Global (not per-agent); applying one overwrites an agent/session form's fields. */
export const agentTemplates = sqliteTable(
  'agent_templates',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    /** AgentConfig JSON (normalized on write by normalizeAgentConfig). */
    config: text('config').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    nameIdx: index('idx_agent_templates_name').on(t.name),
  }),
);

/** Triggers (change: trigger-scheduling). ONE table for every source —
 *  source-specific parameters live in `config` JSON, so a new source needs
 *  no schema change. `next_at` is a real column because the scheduler scans it. */
export const triggers = sqliteTable(
  'triggers',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    name: text('name').notNull(),
    source: text('source').notNull(),
    config: text('config').notNull(), // JSON
    prompt: text('prompt').notNull(),
    sessionMode: text('session_mode', { enum: ['new', 'reuse'] }).notNull(),
    enabled: integer('enabled').notNull(),
    nextAt: integer('next_at'),
    maxRuns: integer('max_runs'),
    runsCount: integer('runs_count').notNull().default(0),
    sessionId: text('session_id'),
    lastFiredAt: integer('last_fired_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    agentIdIdx: index('idx_triggers_agent_id').on(t.agentId),
    nextAtIdx: index('idx_triggers_next_at').on(t.nextAt),
  }),
);

/** One row per firing attempt. `status` is the observable outcome. */
export const triggerRuns = sqliteTable(
  'trigger_runs',
  {
    id: text('id').primaryKey(),
    triggerId: text('trigger_id').notNull(),
    status: text('status', { enum: ['fired', 'skipped', 'missed', 'failed'] }).notNull(),
    triggeredBy: text('triggered_by').notNull(),
    idempotencyKey: text('idempotency_key'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
    sessionId: text('session_id'),
    error: text('error'),
    payloadBytes: integer('payload_bytes'),
  },
  (t) => ({
    triggerIdx: index('idx_trigger_runs_trigger').on(t.triggerId, t.startedAt),
    idemIdx: index('idx_trigger_runs_idem').on(t.triggerId, t.idempotencyKey),
  }),
);

/** System notification table: write-once facts, read by any client. No delivery state. */
export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    severity: text('severity', { enum: ['info', 'warning', 'error'] }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    source: text('source').notNull(),
    sourceId: text('source_id'),
    actionUrl: text('action_url'),
    readAt: integer('read_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    createdAtIdx: index('idx_notifications_created_at').on(t.createdAt),
    unreadIdx: index('idx_notifications_unread').on(t.readAt),
  }),
);
