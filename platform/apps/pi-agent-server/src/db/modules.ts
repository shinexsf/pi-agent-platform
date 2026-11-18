/**
 * 平台功能模块自带的表与迁移。
 *
 * 规则（见 spec `core-sdk`）：**内核的数据库初始化只创建内核对象的表**
 * （Agent / Session / 附件）。其余表由所属模块在装配时执行自己的 DDL 创建 ——
 * 这与渠道包用 `host.executeMigration()` 管自己的表是同一条规则。
 *
 * 为什么这样切：
 * - 内核不认识"通知"和"配置模板"这两个概念，它的 schema 里不该出现它们
 * - 模块下线（未来这些功能可能变成插件）时，它的表跟着一起走，内核零改动
 * - 需要某个模块的表时，内核不会被逼着为一个不相干的功能建表
 *
 * 表对象仍然用 drizzle 定义在这里（而不是 `db/schema.ts`）：仓储层需要的是
 * **表对象**，不是 SQL 字符串；把它们留在内核 schema 里等于让内核替模块声明结构。
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

/** 一个自带表的模块：名字 + 幂等 DDL。 */
export interface DbModule {
  /** 模块名（日志与诊断用）。 */
  name: string;
  /** 幂等 DDL（全部 `CREATE ... IF NOT EXISTS`）。 */
  ddl: string;
}

// ── 通知（系统通知收件箱）──────────────────────────────────────────────────

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

export const notificationsModule: DbModule = {
  name: 'notifications',
  ddl: `
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source TEXT NOT NULL,
      source_id TEXT,
      action_url TEXT,
      read_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at);
  `,
};

// ── 配置模板（全局 agent 配置快照）────────────────────────────────────────

export const agentTemplates = sqliteTable(
  'agent_templates',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    /** AgentConfig JSON（写入前经 normalizeAgentConfig 归一）。 */
    config: text('config').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({
    nameIdx: index('idx_agent_templates_name').on(t.name),
  }),
);

export const templatesModule: DbModule = {
  name: 'agent_templates',
  ddl: `
    CREATE TABLE IF NOT EXISTS agent_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      config TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_templates_name ON agent_templates(name);
  `,
};

/** 装配时要跑迁移的模块清单。 */
export const DB_MODULES: readonly DbModule[] = [notificationsModule, templatesModule];

/** 执行模块迁移（幂等）。由组合根在 `initDb` 之后调用。 */
export function runModuleMigrations(
  raw: { exec(sql: string): unknown },
  modules: readonly DbModule[] = DB_MODULES,
): string[] {
  const applied: string[] = [];
  for (const m of modules) {
    raw.exec(m.ddl);
    applied.push(m.name);
  }
  return applied;
}
