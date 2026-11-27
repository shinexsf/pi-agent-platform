/**
 * 内核数据库初始化：打开 SQLite + 建**内核对象的表**。
 *
 * 只建 Agent / Session / 附件三张表。平台功能模块（通知、配置模板等）的表由
 * 各自模块在装配时用 `runModuleMigrations()` 创建 —— 内核不认识它们。
 *
 * 全部 `CREATE TABLE IF NOT EXISTS`（MVP 阶段不做迁移链）。
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import path from 'node:path';

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
      parent_session_id TEXT,
      forked_from_entry_id TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

    -- 插件迁移台账：谁登记过哪些表。plugin remove 用它提示「留下的表」（不自动删）。
    CREATE TABLE IF NOT EXISTS plugin_migrations (
      plugin_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (plugin_id, name)
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
      -- 磁盘实际文件名（uuid.ext）。drizzle schema 一直有，建表语句曾漏掉：
      -- 新建库上传附件会报 no such column: filename（2026-11-25 修）。
      filename TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, sha)
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id);

  `);

  const db = drizzle(sqlite, { schema });
  return { db, raw: sqlite };
}