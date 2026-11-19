/**
 * 宿主 API 的实现（入口侧）。
 *
 * 内核只声明五个面的**形状**（`packages/core/src/host-api.ts`），实现放在组合根 ——
 * 因为"暴露到什么程度"是入口的决定（桌面端可能不给 `db.query`）。
 *
 * 这是插件与内核之间唯一应该被依赖的缝：插件拿 `HostApi`，不 import 内核内部模块。
 * change: plugin-mechanism-v2 —— 修掉"死接口"：这个对象以前只被打了一条日志，
 * 现在真的传进 `createServerApp()` → `startPluginRuntime()` → `buildHost()`。
 */

import type { HostApi, SessionRepo, WorkerPool } from '@pi-agent-platform/core';
import { buildSystemEnvelope, childLogger, createEventBus, sessionRegistry, systemEventPromptOptions } from '@pi-agent-platform/core';
import type Database from 'better-sqlite3';

const logger = childLogger('host-api');

export interface HostApiDeps {
  raw: Database.Database;
  sessionRepo: SessionRepo;
  workerPool: WorkerPool;
  agentRepo: {
    list(): import('@pi-agent-platform/shared-types').AgentDTO[];
    get(id: string): import('@pi-agent-platform/shared-types').AgentDTO | undefined;
    update(
      id: string,
      patch: Partial<Omit<import('@pi-agent-platform/shared-types').AgentDTO, 'id' | 'createdAt'>>,
    ): import('@pi-agent-platform/shared-types').AgentDTO | undefined;
  };
}

/**
 * 插件迁移台账（`plugin_migrations`）：谁登记过哪些表。
 *
 * 存在理由：`plugin remove` 要能告诉用户"这些表还留着"。平台**不自动删表** ——
 * 删数据不可逆，且表里可能有用户真实数据。
 */
export function recordPluginMigration(raw: Database.Database, pluginId: string, name: string): void {
  raw.prepare('INSERT OR REPLACE INTO plugin_migrations (plugin_id, name, created_at) VALUES (?, ?, ?)').run(
    pluginId,
    name,
    Date.now(),
  );
}

/** 读出某插件留下的表名（CLI 也可直接用 SQL，这里给同口径实现）。 */
export function listPluginMigrationTables(raw: Database.Database, pluginId: string): string[] {
  const rows = raw
    .prepare('SELECT name FROM plugin_migrations WHERE plugin_id = ? ORDER BY name')
    .all(pluginId) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** 进程内事件总线单例 —— 插件之间唯一的协作通道（双方互不相识）。 */
const eventBus = createEventBus();

/** 当前订阅数（验收用：插件卸载后必须归零）。 */
export function pluginEventSubscriberCount(): number {
  return eventBus.subscriberCount();
}

export function createHostApi(deps: HostApiDeps): HostApi {
  return {
    db: {
      migrate(name, ddl) {
        // DDL 幂等由插件负责（`CREATE TABLE IF NOT EXISTS` 这类）。
        deps.raw.exec(ddl);
        logger.info({ name }, 'plugin migration executed');
      },
      query(sql, params) {
        // 读写都开放：插件完全可信。每条 query 进审计日志（谁 / 什么 SQL / 多久 / 改了几行）。
        const startedAt = Date.now();
        const stmt = deps.raw.prepare(sql);
        // 不传参数时不能给空数组（better-sqlite3 会报 "Too many parameter values"）。
        const args = params && params.length > 0 ? params : undefined;
        const log = (changes?: number) =>
          logger.debug({ sql, params: params?.length ?? 0, ms: Date.now() - startedAt, changes }, 'plugin db query');
        // INSERT / UPDATE / DDL 走 `run()`（`all()` 对非 reader 语句会抛错）——
        // 契约只有一个 `query` 口，所以这里必须自己分流，否则"读写都开放"是假的。
        if (!stmt.reader) {
          const info = args ? stmt.run(...args) : stmt.run();
          log(info.changes);
          return [] as never;
        }
        const rows = args ? stmt.all(...args) : stmt.all();
        log();
        return rows as never;
      },
    },

    sessions: {
      call: (sessionId, method, args) => deps.workerPool.call(sessionId, method, args ?? []),
      get(sessionId) {
        const live = sessionRegistry().get(sessionId);
        if (live) return { id: sessionId, agentId: live.agentId, status: live.run.status, hasRow: live.hasRow };
        const row = deps.sessionRepo.get(sessionId);
        if (!row) return null;
        return { id: sessionId, agentId: row.agentId, status: 'idle', hasRow: true };
      },
      list() {
        // 运行态对象是唯一真值；DB 行可能有但还没有活进程（placeholder / 已归档）。
        return sessionRegistry()
          .list()
          .map((s) => ({ id: s.id, agentId: s.agentId, status: s.run.status, hasRow: s.hasRow }));
      },
      status(sessionId) {
        const live = sessionRegistry().get(sessionId);
        if (!live) return deps.sessionRepo.get(sessionId) ? 'idle' : 'missing';
        return live.run.status;
      },
      hasRow: (sessionId) => Boolean(deps.sessionRepo.get(sessionId)),
      subscribe: (sessionId, listener, onDispose) =>
        sessionRegistry().track(sessionId).subscribe(listener, onDispose),
      // 无人值守跑一轮的入口：三态语义见内核 `SessionRegistry.ensure`。
      ensure: (input) => sessionRegistry().ensure(input),
      // 非用户消息（信封）的唯一投递口：文本由内核构造，返回即"送到"。
      async systemEvent(input) {
        const envelope = buildSystemEnvelope({
          kind: input.kind,
          ...(input.source ? { source: input.source } : {}),
          ...(input.name ? { name: input.name } : {}),
          fired: new Date().toISOString(),
          ...(input.run ? { run: input.run } : {}),
          ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
          ...(input.data !== undefined ? { data: input.data } : {}),
        });
        // `streamingBehavior` 原样转给 pi：agent 正忙时由调用方决定排队/插队/报错。
        await deps.workerPool.call(input.sessionId, 'prompt', [
          envelope,
          systemEventPromptOptions(input.streamingBehavior),
        ]);
      },
    },

    bus: {
      publish: (topic, payload) => eventBus.emit(topic, payload),
      subscribe: (topic, listener) => eventBus.subscribe(topic, listener),
    },

    agents: {
      list: () => deps.agentRepo.list(),
      get: (agentId) => deps.agentRepo.get(agentId) ?? null,
      update(agentId, patch) {
        const updated = deps.agentRepo.update(agentId, patch);
        if (!updated) throw new Error(`agent not found: ${agentId}`);
      },
    },

    lifecycle: {
      onSessionCreated: (hook) => sessionRegistry().onSessionCreated(hook),
      onSessionDisposed: (hook) => sessionRegistry().onSessionDisposed(hook),
    },
  };
}
