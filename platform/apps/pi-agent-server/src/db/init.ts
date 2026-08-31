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
  'agents_v1',
  'sessions_v1',
  'attachments_v1',
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
      system_prompt TEXT,
      append_system_prompt TEXT,
      tools TEXT,
      config TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      model TEXT NOT NULL,
      thinking_level TEXT,
      system_prompt TEXT,
      append_system_prompt TEXT,
      tools TEXT,
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
  `);

  const db = drizzle(sqlite, { schema });
  return { db, raw: sqlite };
}