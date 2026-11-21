/**
 * admin（bundled 插件）—— 平台管理动作。
 *
 * 它**不是控制面**：没有方法级授权、没有审计表、没有允许列表。启用与否只由
 * `agent.config.plugins` 决定（与任何插件一样）。拿到这 8 个工具 = 这个 agent 能管平台，
 * 这是"插件可信 + 无运行时沙箱"的直接推论；出多用户时必须重做一道门（见 invariants）。
 *
 * 一份 handler 经 `host.actions.define` 同时投影成四样东西：
 *
 * | 投影 | 谁用 | 声明 |
 * |---|---|---|
 * | service（`admin.session.restart` …） | 别的插件的 server facet | `service: true` |
 * | 反向方法（`admin.<action>`） | 本插件自己的 worker（自动注册的工具就走这条） | 默认开 |
 * | 工具（`admin_<action>`） | 模型 | `tool: { exposure: 'deferred', namespace: 'admin' }` |
 * | HTTP（`POST /api/p/admin/<path>`） | 外部客户端 | `http: {}`（全局开关默认关） |
 *
 * `scope: 'public'` 是刻意的：管理是**跨插件**的能力（`scheduler` 想查会话状态，
 * 不该先变成 `admin` 的 owner）。
 *
 * 审计 = 每个 handler 一条结构化日志（`caller.sessionId` / 动作 / 目标 / 结果）。
 * 平台的会话历史本身就是审计（调用也会出现在调用方会话里），所以不落表。
 */

import type { PluginActionDefinition, PluginActionContext, PluginServerHost } from '@pi-agent-platform/plugin-types';

/** pi 工具参数 schema 的一小块（平台只透传，不解释）。 */
const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const;

/** 每个动作统一记一条：谁（会话 / 插件）调了什么、打向谁、成没成。 */
function logCall(
  host: PluginServerHost,
  action: string,
  ctx: PluginActionContext | undefined,
  target: string | undefined,
  result: 'ok' | 'error',
  extra: Record<string, unknown> = {},
): void {
  host.log(result === 'ok' ? 'info' : 'warn', `action ${action} ${result}`, {
    action,
    callerSessionId: ctx?.sessionId ?? null,
    callerPluginId: ctx?.caller?.pluginId ?? null,
    callerKind: ctx?.caller?.kind ?? null,
    target: target ?? null,
    ...extra,
  });
}

/** 包一层：统一错误日志（错误仍然抛给调用方，不改语义）。 */
function withLog<A>(
  host: PluginServerHost,
  action: string,
  targetOf: (params: A) => string | undefined,
  fn: (params: A, ctx: PluginActionContext) => unknown | Promise<unknown>,
): PluginActionDefinition['handler'] {
  return async (raw, ctx) => {
    const params = (raw ?? {}) as A;
    try {
      const out = await fn(params, ctx);
      logCall(host, action, ctx, targetOf(params), 'ok');
      return out;
    } catch (err) {
      logCall(host, action, ctx, targetOf(params), 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
}

export default {
  init(host: PluginServerHost) {
    const sessionIdOf = (p?: { id?: string }) => p?.id;

    const actions: Record<string, PluginActionDefinition> = {
      // ── server.status ──
      'server.status': {
        scope: 'public',
        service: true,
        params: NO_ARGS,
        handler: withLog(host, 'admin.server.status', () => undefined, () => host.lifecycle.runtime()),
        tool: {
          description:
            'Server 运行状态：版本、uptime、端口、pid、worker 池统计（active / placeholders / max / pendingCalls）。不含任何凭据。',
          exposure: 'deferred',
          namespace: { name: 'admin', instructions: '平台管理动作（状态 / agent / session）。' },
        },
        http: {},
      },

      // ── agent.list ──
      'agent.list': {
        scope: 'public',
        service: true,
        params: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'name 子串（不区分大小写）' },
            workspacePath: { type: 'string', description: 'workspacePath 前缀（含子目录）' },
            description: { type: 'string', description: 'description 子串（不区分大小写）' },
          },
          additionalProperties: false,
        },
        handler: withLog(
          host,
          'admin.agent.list',
          () => undefined,
          async (p: { name?: string; workspacePath?: string; description?: string }) => {
            let rows = await host.agents.list();
            if (p.workspacePath) {
              const target = p.workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
              rows = rows.filter((a) => {
                const wp = String(a.workspacePath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
                return wp === target || wp.startsWith(`${target}/`);
              });
            }
            if (p.name) {
              const q = p.name.toLowerCase();
              rows = rows.filter((a) => String(a.name ?? '').toLowerCase().includes(q));
            }
            if (p.description) {
              const q = p.description.toLowerCase();
              rows = rows.filter((a) => String(a.description ?? '').toLowerCase().includes(q));
            }
            // 精简 DTO：完整 config 可能很大，要看细节用 agent.get
            return {
              agents: rows.map((a) => ({
                id: a.id,
                name: a.name,
                description: a.description,
                workspacePath: a.workspacePath,
                model: a.model,
                thinkingLevel: a.thinkingLevel,
              })),
              total: rows.length,
            };
          },
        ),
        tool: {
          description: '搜索 agents：name / workspacePath / description 组合模糊过滤（子串、AND，不传=全部）。',
          exposure: 'deferred',
          namespace: 'admin',
        },
        http: {},
      },

      // ── agent.get ──
      'agent.get': {
        scope: 'public',
        service: true,
        params: {
          type: 'object',
          properties: { id: { type: 'string', description: 'agent id' } },
          required: ['id'],
          additionalProperties: false,
        },
        handler: withLog(host, 'admin.agent.get', sessionIdOf, async (p: { id: string }) => {
          const found = await host.agents.get(p.id);
          if (!found) throw new Error(`Agent not found: ${p.id}`);
          return found;
        }),
        tool: {
          description: '按 id 取 agent 完整配置（含 config）。',
          exposure: 'deferred',
          namespace: 'admin',
        },
        http: {},
      },

      // ── agent.update ──
      'agent.update': {
        scope: 'public',
        service: true,
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'agent id' },
            patch: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                workspacePath: { type: 'string', description: '必须是已存在的绝对路径' },
                model: { type: 'string', description: 'provider/modelId' },
                thinkingLevel: { type: 'string', enum: ['off', 'low', 'medium', 'high'] },
                config: { type: 'object', description: 'AgentConfig 整体替换' },
              },
              additionalProperties: false,
            },
          },
          required: ['id', 'patch'],
          additionalProperties: false,
        },
        handler: withLog(
          host,
          'admin.agent.update',
          (p: { id: string }) => p.id,
          async (p: { id: string; patch: Record<string, unknown> }) => {
            const existing = await host.agents.get(p.id);
            if (!existing) throw new Error(`Agent not found: ${p.id}`);
            await host.agents.update(p.id, p.patch as never);
            return await host.agents.get(p.id);
          },
        ),
        tool: {
          description:
            '局部更新 agent 配置（name/description/workspacePath/model/thinkingLevel/config）。仅影响该 agent 未来新建的 session——运行中的 session 是创建时快照。',
          exposure: 'deferred',
          namespace: 'admin',
        },
        http: {},
      },

      // ── session.list ──
      'session.list': {
        scope: 'public',
        service: true,
        params: {
          type: 'object',
          properties: {
            agentId: { type: 'string', description: '精确匹配' },
            title: { type: 'string', description: 'title 子串（不区分大小写）' },
            status: { type: 'string', enum: ['active', 'archived'] },
          },
          additionalProperties: false,
        },
        handler: withLog(
          host,
          'admin.session.list',
          () => undefined,
          async (p: { agentId?: string; title?: string; status?: 'active' | 'archived' }) => {
            const sessions = await host.sessions.find(p);
            return { sessions, total: sessions.length };
          },
        ),
        tool: {
          description: '搜索 sessions：agentId 精确 + title 模糊 + status(active|archived)，AND 关系；每项含 workerAlive。',
          exposure: 'deferred',
          namespace: 'admin',
        },
        http: {},
      },

      // ── session.get ──
      'session.get': {
        scope: 'public',
        service: true,
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        handler: withLog(host, 'admin.session.get', sessionIdOf, async (p: { id: string }) => {
          const s = await host.sessions.detail(p.id);
          if (!s) throw new Error(`Session not found: ${p.id}`);
          return s;
        }),
        tool: {
          description: '按 id 取 session 完整详情（含 config、workerAlive）。',
          exposure: 'deferred',
          namespace: 'admin',
        },
        http: {},
      },

      // ── session.update ──
      'session.update': {
        scope: 'public',
        service: true,
        params: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            patch: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '1-200 字符；空串=清空' },
                model: { type: 'string', description: 'provider/modelId（worker 存活时立即切换）' },
                thinkingLevel: { type: 'string', enum: ['off', 'low', 'medium', 'high'] },
                config: { type: 'object', description: 'AgentConfig 整体替换；⚠️ 下次 spawn 生效' },
              },
              additionalProperties: false,
            },
          },
          required: ['id', 'patch'],
          additionalProperties: false,
        },
        handler: withLog(
          host,
          'admin.session.update',
          (p: { id: string }) => p.id,
          async (p: { id: string; patch: Record<string, unknown> }) => {
            // 生效时机由宿主保证（model/thinkingLevel 即时、config 下次 spawn）；
            // 插件只转述，不自己拼"IPC + DB 双写"。
            return await host.sessions.update(p.id, p.patch as never);
          },
        ),
        tool: {
          description:
            '局部更新 session：model/thinkingLevel 即时生效、title 走改名同步、config.* 仅写 DB（下次 spawn 生效；想立即生效配合 session.restart）。',
          exposure: 'deferred',
          namespace: 'admin',
        },
        http: {},
      },

      // ── session.restart ──
      'session.restart': {
        scope: 'public',
        service: true,
        params: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        handler: withLog(host, 'admin.session.restart', sessionIdOf, async (p: { id: string }) =>
          host.sessions.restart(p.id),
        ),
        tool: {
          description:
            '重启 session worker：优雅 kill 后重建并复用历史（重新打开并加载）。sessions 行与 IM/Web 渠道映射不受影响。用于让 config.* 修改立即生效；正在跑的 turn 会被中断（busy 时会被拒绝）。',
          exposure: 'deferred',
          namespace: 'admin',
        },
        http: {},
      },
    };

    host.actions.define(actions);

    // 只读状态端点（给 web 页面用）：动作的 HTTP 面只有 POST 且默认关，
    // 页面要的是 GET 且必须常开 —— 这正是"作者手写路由"的地盘。
    host.http.route({
      method: 'GET',
      path: '/status',
      handler: async () => ({
        json: {
          runtime: host.lifecycle.runtime(),
          counts: {
            agents: (await host.agents.list()).length,
            sessions: (await host.sessions.find()).length,
            actions: host.actions ? Object.keys(actions).length : 0,
          },
        },
      }),
    });

    // 只读状态页（R1）：页面数据来自上面那个常开端点
    host.ui.page({ path: '/admin-status', label: '平台状态', icon: 'monitor', component: 'page', order: 60 });

    host.log('info', `admin: 声明 ${Object.keys(actions).length} 个动作（scope:public + deferred 工具）`);
  },
};
