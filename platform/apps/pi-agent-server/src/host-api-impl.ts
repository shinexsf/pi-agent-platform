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
import {
  buildSystemEnvelope,
  childLogger,
  createPluginBus,
  createPluginServices,
  renameSession,
  pluginActions as pluginActionsSingleton,
  sessionRegistry,
  systemEventPromptOptions,
} from '@pi-agent-platform/core';
import type Database from 'better-sqlite3';

const logger = childLogger('host-api');

export interface HostApiDeps {
  raw: Database.Database;
  /** 进程事实（`lifecycle.runtime()` 用）：版本 / 环境 / 端口 / 池上限。 */
  version: string;
  nodeEnv: string;
  port: number;
  maxWorkers: number;
  sessionRepo: SessionRepo;
  workerPool: WorkerPool;
  /** 附件存取（`host.attachments` 的数据源；插件只拿到 upload / resolvePath）。 */
  attachmentStore: import('@pi-agent-platform/core').AttachmentStore;
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

/** 插件间广播总线单例（带声明 / owner 管控 / 送达状态）。 */
const pluginBus = createPluginBus();

/** 插件间定向调用注册表（恰好一个提供者 / 返回业务数据）。 */
const pluginServices = createPluginServices();

/**
 * 动作登记表：**内核单例**（`pluginActions()`），这里只是取个本地名字。
 *
 * 不能在这里 `createPluginActions()` 新建一个 —— spawn 前的会话装配在 `core` 里读同一张表，
 * 两个实例的症状是"插件声明了动作，但 worker 永远收不到工具描述符"。
 */
const pluginActions = pluginActionsSingleton();

/** 动作登记表单例（组合根共享给 spawn 逻辑与插件运行期）。 */
export function pluginActionRegistry(): typeof pluginActions {
  return pluginActions;
}

/** 当前订阅数（验收用：插件卸载后必须归零）。 */
export function pluginEventSubscriberCount(): number {
  return pluginBus.subscriberCount();
}

/** 当前服务数（验收用：插件卸载后必须归零）。 */
export function pluginServiceCount(): number {
  return pluginServices.count();
}

/** 某插件的互操作声明（`GET /api/plugins/:id/extensions` 附带的目录片段）。 */
export function pluginInteropFor(pluginId: string): {
  topics: ReturnType<typeof pluginBus.topicsOf>;
  services: ReturnType<typeof pluginServices.listOf>;
} {
  return { topics: pluginBus.topicsOf(pluginId), services: pluginServices.listOf(pluginId) };
}

/** 动作目录（`GET /api/runtime/actions`）。 */
export function pluginActionSnapshot(): ReturnType<typeof pluginActions.list> {
  return pluginActions.list();
}

/** 某插件的动作（目录页附带）。 */
export function pluginActionsOf(pluginId: string): ReturnType<typeof pluginActions.listOf> {
  return pluginActions.listOf(pluginId);
}

/** 目录快照（查询面 / 诊断用）。 */
export function pluginInteropSnapshot(): { topics: ReturnType<typeof pluginBus.topics>; services: ReturnType<typeof pluginServices.list> } {
  return { topics: pluginBus.topics(), services: pluginServices.list() };
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

      // ── 会话管理（原 capabilities/handlers/session.ts 的行为，逐条搬过来）──
      detail(sessionId) {
        const row = deps.sessionRepo.get(sessionId);
        if (!row) return null;
        return { ...row, workerAlive: deps.workerPool.has(sessionId) };
      },
      find(filter) {
        let rows = deps.sessionRepo.list(filter?.agentId);
        if (filter?.title) {
          const q = filter.title.toLowerCase();
          rows = rows.filter((r) => (r.title ?? '').toLowerCase().includes(q));
        }
        if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
        return rows.map((r) => ({ ...r, workerAlive: deps.workerPool.has(r.id) }));
      },
      async update(sessionId, patch) {
        const existing = deps.sessionRepo.get(sessionId);
        if (!existing) throw Object.assign(new Error(`Session not found: ${sessionId}`), { name: 'NotFoundError' });

        // title → 共享改名语义（与 HTTP 路由同一份实现）
        if (patch.title !== undefined) {
          const t = patch.title.trim();
          if (t.length > 200) throw new Error('Title too long (max 200 chars)');
          await renameSession({ sessionRepo: deps.sessionRepo, workerPool: deps.workerPool }, sessionId, t || undefined);
        }

        // model → worker 活着时立即生效（IPC + 运行态缓存 + DB），死了只写 DB
        if (patch.model !== undefined) {
          const slashIdx = patch.model.indexOf('/');
          if (slashIdx <= 0 || !patch.model.slice(slashIdx + 1)) {
            throw new Error(`Invalid model format (expected provider/modelId): ${patch.model}`);
          }
          if (deps.workerPool.has(sessionId)) {
            const provider = patch.model.slice(0, slashIdx);
            const modelId = patch.model.slice(slashIdx + 1);
            await deps.workerPool.call(sessionId, 'setModel', [provider, modelId]);
            const live = sessionRegistry().get(sessionId);
            if (live) live.model = { provider, modelId };
          }
          deps.sessionRepo.update(sessionId, { model: patch.model });
        }

        if (patch.thinkingLevel !== undefined) {
          const VALID = ['off', 'low', 'medium', 'high'] as const;
          if (!VALID.includes(patch.thinkingLevel)) {
            throw new Error(`Invalid thinkingLevel (must be one of ${VALID.join(', ')})`);
          }
          if (deps.workerPool.has(sessionId)) {
            await deps.workerPool.call(sessionId, 'setThinkingLevel', [patch.thinkingLevel]);
            const live = sessionRegistry().get(sessionId);
            if (live) live.thinkingLevel = patch.thinkingLevel;
          }
          deps.sessionRepo.update(sessionId, { thinkingLevel: patch.thinkingLevel || undefined });
        }

        // config.* → 只写 DB（完全快照语义：下次 spawn 生效）
        if (patch.config !== undefined) {
          deps.sessionRepo.update(sessionId, { config: patch.config });
        }

        return { ...deps.sessionRepo.get(sessionId)!, workerAlive: deps.workerPool.has(sessionId) };
      },
      async restart(sessionId) {
        const existing = deps.sessionRepo.get(sessionId);
        if (!existing) throw Object.assign(new Error(`Session not found: ${sessionId}`), { name: 'NotFoundError' });
        const agent = deps.agentRepo.get(existing.agentId);
        if (!agent) throw new Error(`Agent not found for session: ${existing.agentId}`);

        // busy 检查：有在飞的 master→worker 调用 ⇒ 一轮正在跑 ⇒ 拒绝（MUST NOT kill）
        const entry = deps.workerPool.get(sessionId);
        if (entry && entry.pendingCalls.size > 0) {
          throw new Error('Session busy (turn in progress) — retry later');
        }

        if (deps.workerPool.has(sessionId)) {
          await deps.workerPool.kill(sessionId, 'admin-restart');
        }
        // respawn 复用 piSessionPath 恢复历史；sessions 行与渠道映射都不碰
        await sessionRegistry().getOrCreate(sessionId, agent);
        const newEntry = deps.workerPool.get(sessionId);
        return { restarted: true as const, workerPid: newEntry?.workerPid ?? -1, historyRestored: true as const };
      },
    },

    bus: {
      declare: (pluginId, topic, options) => pluginBus.declare(pluginId, topic, options),
      publish: (pluginId, topic, payload) => pluginBus.publish(pluginId, topic, payload),
      publishAndWait: (pluginId, topic, payload, options) => pluginBus.publishAndWait(pluginId, topic, payload, options),
      subscribe: (pluginId, topic, listener) => pluginBus.subscribe(pluginId, topic, listener),
      topics: () => pluginBus.topics(),
      topicsOf: (pluginId) => pluginBus.topicsOf(pluginId),
      disposePlugin: (pluginId) => pluginBus.disposePlugin(pluginId),
    },

    actions: {
      define: (pluginId, actions) => pluginActions.define(pluginId, actions),
      resolve: (name) => pluginActions.resolve(name),
      reachOf: (name) => pluginActions.reachOf(name),
      descriptorsFor: (pluginIds) => pluginActions.descriptorsFor(pluginIds),
      descriptorsOf: (pluginId) => pluginActions.descriptorsOf(pluginId),
      list: () => pluginActions.list(),
      listOf: (pluginId) => pluginActions.listOf(pluginId),
      disposePlugin: (pluginId) => pluginActions.disposePlugin(pluginId),
      count: () => pluginActions.count(),
      clear: () => pluginActions.clear(),
    },

    services: {
      provide: (pluginId, name, handler, options) => pluginServices.provide(pluginId, name, handler, options),
      call: (callerPluginId, name, payload, options) => pluginServices.call(callerPluginId, name, payload, options),
      list: (filter) => pluginServices.list(filter),
      listOf: (pluginId) => pluginServices.listOf(pluginId),
      namespaces: () => pluginServices.namespaces(),
      disposePlugin: (pluginId) => pluginServices.disposePlugin(pluginId),
    },

    // 附件面：只给两个动作（`upload` / `resolvePath`），不给 store 句柄 ——
    // 那个对象带 `delete` / 目录布局，给出去等于让插件能绕过引用计数删文件。
    attachments: {
      async upload(input) {
        const record = await deps.attachmentStore.upsert({
          sessionId: input.sessionId,
          bytes: input.bytes,
          mimeType: input.mimeType,
          originalFilename: input.filename,
        });
        // 全量归还 row 的对外字段：worker 的 promptOptions 需要 sha/filename 才能读盘。
        return {
          id: record.row.id,
          sha: record.row.sha,
          mimeType: record.row.mimeType,
          sizeBytes: record.row.sizeBytes,
          filename: record.row.filename,
          originalFilename: record.row.originalFilename,
        };
      },
      resolvePath: (sessionId, name) => deps.attachmentStore.resolvePath(sessionId, name),
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
      // 只读运行态快照：数据而不是句柄（插件拿不到 workerPool）。
      runtime() {
        const list = deps.workerPool.list();
        return {
          version: deps.version,
          uptimeMs: Math.round(process.uptime() * 1000),
          nodeEnv: deps.nodeEnv,
          port: deps.port,
          pid: process.pid,
          workers: {
            active: list.filter((w) => w.hasRow).length,
            placeholders: list.filter((w) => !w.hasRow).length,
            max: deps.maxWorkers,
            pendingCalls: list.reduce((n, w) => n + w.pendingCalls, 0),
          },
        };
      },
    },
  };
}
