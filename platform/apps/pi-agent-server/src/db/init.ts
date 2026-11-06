/**
 * Database init: open SQLite + auto-create tables.
 *
 * Uses CREATE TABLE IF NOT EXISTS (no migration toolchain for MVP).
 * Master + better-sqlite3 (sync API) + drizzle wrapper.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import path from 'node:path';

/** Migration versions. Append-only; bumping the version adds new CREATE TABLE
 *  statements to the idempotent init above. Renumbered as the schema evolves. */
export const MIGRATIONS = [
  'agents_v2',  // config consolidation: removed system_prompt, append_system_prompt, tools
  'sessions_v2',  // config consolidation: removed system_prompt, append_system_prompt, tools
  'attachments_v1',
  'agent_templates_v1',  // saved configuration templates (global)
  'triggers_v1',  // triggers / trigger_runs / notifications (change: trigger-scheduling)
] as const;

export type DB = ReturnType<typeof drizzle<typeof schema>>;

export function initDb(databasePath: string): { db: DB; raw: Database.Database } {
  const absPath = path.resolve(databasePath);
  const sqlite = new Database(absPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  // Auto-create tables (idempotent)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      workspace_path TEXT NOT NULL,
      model TEXT NOT NULL,
      thinking_level TEXT,
      config TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      model TEXT NOT NULL,
      thinking_level TEXT,
      config TEXT,
      pi_session_path TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
      title TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_agent_id ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_active_at ON sessions(last_active_at);

    -- Image attachments (user-pasted only). Read-tool images do NOT go here.
    -- PK (session_id, sha): content-addressed within a session; cross-session duplicates
    -- are allowed (each session owns its bytes under <root>/<sessionId>/<sha>.<ext>).
    CREATE TABLE IF NOT EXISTS attachments (
      session_id TEXT NOT NULL,
      sha TEXT NOT NULL,
      id TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      original_filename TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, sha)
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id);

    -- Saved configuration templates (global; snapshot of the seven AgentConfig fields).
    CREATE TABLE IF NOT EXISTS agent_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      config TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_templates_name ON agent_templates(name);

    -- Triggers (change: trigger-scheduling). One table for every source:
    -- source-specific parameters live in config JSON, never in dedicated columns.
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      name TEXT NOT NULL,
      source TEXT NOT NULL,
      config TEXT NOT NULL,
      prompt TEXT NOT NULL,
      session_mode TEXT NOT NULL CHECK (session_mode IN ('new', 'reuse')),
      enabled INTEGER NOT NULL,
      next_at INTEGER,
      max_runs INTEGER,
      runs_count INTEGER NOT NULL DEFAULT 0,
      session_id TEXT,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_triggers_agent_id ON triggers(agent_id);
    CREATE INDEX IF NOT EXISTS idx_triggers_next_at ON triggers(next_at);

    -- One row per firing attempt (fired | skipped | missed | failed).
    CREATE TABLE IF NOT EXISTS trigger_runs (
      id TEXT PRIMARY KEY,
      trigger_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('fired', 'skipped', 'missed', 'failed')),
      triggered_by TEXT NOT NULL,
      idempotency_key TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      session_id TEXT,
      error TEXT,
      payload_bytes INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_trigger_runs_trigger ON trigger_runs(trigger_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_trigger_runs_idem ON trigger_runs(trigger_id, idempotency_key);

    -- Notifications (client-agnostic inbox). Deliveries are a JSON array of
    -- per-channel outcomes so a failed channel never blocks the row.
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      action_url TEXT,
      read_at INTEGER,
      created_at INTEGER NOT NULL,
      deliveries TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at);
  `);

  const db = drizzle(sqlite, { schema });
  return { db, raw: sqlite };
}