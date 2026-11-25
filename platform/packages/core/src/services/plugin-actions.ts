/**
 * 动作登记表（change: plugin-actions-contract）。
 *
 * 作者写**一份 handler**，用五个独立字段声明它怎么被暴露：
 *
 * | 字段 | 谁会看到 | 缺省 |
 * |---|---|---|
 * | `reverse` | 自己插件的 worker（反向方法 `<id>.<action>`） | `true` |
 * | `scope` | 只约束 `reverse` 的来源（`own` 只有自己 / `public` 谁都能调） | `'own'` |
 * | `service` | 别的插件的 server facet（`host.services`） | `false` |
 * | `tool` | 模型（pi 工具，经 worker → reverse 执行） | `null` |
 * | `http` | 外部客户端（`POST /api/p/<id>/<path>`） | `null` |
 *
 * 默认值判据：**漏了会静默坏的面默认开（reverse），漏了会明确报错的面默认关（service/tool/http）**。
 *
 * 本模块只做「校验 + 记账」：四类**产物**（反向方法 / service / 工具描述符 / HTTP 路由）
 * 由 `plugin-extensions.ts` 的 `buildHost()` 投影出来 —— 它已经持有反向方法表、插件路由表
 * 和 service 面，再开第二套就是第二份真相。校验在这里、副作用在那边，是为了让校验可单测、
 * 也让"整批不注册"这条能一次判定完再动手。
 */

import {
  isReservedPluginId,
  pluginMethodName,
  type ActionDescriptor,
} from '@pi-agent-platform/ipc-protocol';
import type { ActionToolSpec } from '@pi-agent-platform/ipc-protocol';
import type { PluginActionDefinition, PluginActionToolExposure } from '@pi-agent-platform/plugin-types';
import { childLogger } from '../logger.js';

const logger = childLogger('plugin-actions');

export type ActionReach = 'own' | 'public';

/** 工具描述符 = IPC 契约里的 `ActionDescriptor`（同一形状，避免两份）。 */
export type ActionToolDescriptor = ActionDescriptor;

/** 一条已登记动作（全名 = `<pluginId>.<action>`）。 */
export interface ActionRecord {
  pluginId: string;
  action: string;
  /** 全名：反向方法名 / service 名 / HTTP 路径都从它推导。 */
  name: string;
  params?: Record<string, unknown>;
  handler: PluginActionDefinition['handler'];
  reverse: boolean;
  reach: ActionReach;
  service: boolean;
  /** service 投影的发现标签（`<定义方 pluginId>.<接口名>`），缺省不带。 */
  namespace?: string;
  tool?: ActionToolSpec;
  /** 已推导好的子路径（含前导 `/`）。 */
  httpPath?: string;
}

/** 目录项（查询面 `/api/runtime/actions`）。 */
export interface ActionInfo {
  name: string;
  owner: string;
  scope: ActionReach;
  reverse: boolean;
  service: boolean;
  hasTool: boolean;
  http: string | null;
  hasParams: boolean;
}

export type DefineFailure =
  | 'reserved-plugin-id'
  | 'not-an-object'
  | 'empty'
  | 'bad-action-name'
  | 'bad-handler'
  | 'bad-params'
  | 'params-required'
  | 'tool-needs-reverse'
  | 'deferred-needs-no-prompt'
  | 'bad-http'
  | 'bad-http-path'
  | 'duplicate'
  | 'tool-name-duplicate';

export interface DefineResult {
  ok: boolean;
  reason?: DefineFailure;
  /** 面向作者的错误文本（含具体动作名与成因）。 */
  error?: string;
  accepted?: ActionRecord[];
}

export interface PluginActions {
  /** 登记一组动作；任何一条不合法 → 整批不登记并返回错误。 */
  define(pluginId: string, actions: Record<string, PluginActionDefinition>): DefineResult;
  /** 按全名取一条（master 侧 reach 校验、HTTP 派发都用它）。 */
  resolve(name: string): ActionRecord | undefined;
  /** 名字 → reach（worker-pool 的归属校验钩子）。 */
  reachOf(name: string): ActionReach | undefined;
  /** 给 worker 的工具描述符（只取给了 `tool` 的）。 */
  descriptorsFor(pluginIds: readonly string[]): ActionToolDescriptor[];
  /** 某插件的描述符全量（不看会话）。 */
  descriptorsOf(pluginId: string): ActionToolDescriptor[];
  list(): ActionInfo[];
  listOf(pluginId: string): ActionInfo[];
  /** 卸载兜底：撤销该插件的全部动作。 */
  disposePlugin(pluginId: string): void;
  count(): number;
  clear(): void;
}

// ---------- 校验 ----------

const ACTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `<pluginId>__<action 点→下划线>`：默认工具名（下划线是 pi 的工具名惯例）。 */
export function defaultToolName(pluginId: string, action: string): string {
  return `${pluginId}__${action.replace(/[.\-]/g, '_')}`;
}

/** 动作名 → 子路径：`task.create` → `/task/create`。 */
export function defaultHttpPath(action: string): string {
  return `/${action.replace(/\./g, '/')}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 单条动作校验（纯函数）：返回错误或规整后的记录片段。 */
function checkOne(
  pluginId: string,
  action: string,
  def: PluginActionDefinition,
): { error?: { reason: DefineFailure; message: string }; toolName?: string } {
  if (!ACTION_NAME_RE.test(action)) {
    return { error: { reason: 'bad-action-name', message: `动作名『${action}』不合法（只允许字母数字与 . _ -，且不能以符号开头）` } };
  }
  if (!isPlainObject(def)) {
    return { error: { reason: 'not-an-object', message: `动作『${action}』的定义必须是对象` } };
  }
  if (typeof def.handler !== 'function') {
    return { error: { reason: 'bad-handler', message: `动作『${action}』缺少 handler 函数` } };
  }
  if (def.params !== undefined) {
    if (!isPlainObject(def.params)) {
      return { error: { reason: 'bad-params', message: `动作『${action}』的 params 必须是 JSON Schema 对象` } };
    }
    try {
      JSON.stringify(def.params);
    } catch {
      return { error: { reason: 'bad-params', message: `动作『${action}』的 params 不可 JSON 序列化` } };
    }
  }
  const wantsTool = def.tool !== undefined && def.tool !== null;
  const wantsHttp = def.http !== undefined && def.http !== null;

  if ((wantsTool || wantsHttp) && !def.params) {
    return {
      error: {
        reason: 'params-required',
        message: `动作『${action}』暴露了 ${[wantsTool ? 'tool' : null, wantsHttp ? 'http' : null].filter(Boolean).join(' / ')}，必须给 params（没有 schema 就没法校验入参）`,
      },
    };
  }
  // 工具在 worker 里跑，只能经反向方法回到 handler；HTTP 在主进程直调，不要求 reverse。
  if (wantsTool && def.reverse === false) {
    return {
      error: { reason: 'tool-needs-reverse', message: `动作『${action}』暴露了 tool，reverse 不能为 false（工具必须经反向方法执行）` },
    };
  }
  if (def.http !== undefined && def.http !== null && !isPlainObject(def.http)) {
    return {
      error: { reason: 'bad-http', message: `动作『${action}』的 http 必须是对象（如 { path: '/run' }），不接受布尔` },
    };
  }
  if (wantsHttp) {
    const p = (def.http as { path?: unknown }).path;
    if (p !== undefined) {
      if (typeof p !== 'string' || !p.startsWith('/')) {
        return { error: { reason: 'bad-http-path', message: `动作『${action}』的 http.path 必须以 / 开头` } };
      }
      // 通配/参数是 `host.http.route` 的地盘：动作面的路径 MUST 精确，
      // 否则"一个动作一个地址"这条就不能机械校验了。
      if (p.includes(':') || p.includes('*')) {
        return {
          error: { reason: 'bad-http-path', message: `动作『${action}』的 http.path 不允许 :param 或 *（需要通配请用 host.http.route）` },
        };
      }
      if (p.startsWith('/api/p/')) {
        return { error: { reason: 'bad-http-path', message: `动作『${action}』的 http.path 不带 /api/p/ 前缀（平台已加上）` } };
      }
    }
  }

  let toolName: string | undefined;
  if (wantsTool) {
    const tool = def.tool as PluginActionToolExposure;
    if (!isPlainObject(tool) || typeof tool.description !== 'string' || !tool.description.trim()) {
      return { error: { reason: 'bad-handler', message: `动作『${action}』的 tool 需要非空 description` } };
    }
    if (tool.exposure === 'deferred' && (tool.promptSnippet || tool.promptGuidelines)) {
      return {
        error: {
          reason: 'deferred-needs-no-prompt',
          message: `动作『${action}』是 deferred 工具，不能配 promptSnippet / promptGuidelines（激活会重建 system prompt、破前缀缓存）`,
        },
      };
    }
    toolName = tool.name ?? defaultToolName(pluginId, action);
    if (typeof toolName !== 'string' || !/^[A-Za-z0-9_-]+$/.test(toolName)) {
      return { error: { reason: 'bad-action-name', message: `动作『${action}』的工具名『${String(toolName)}』不合法` } };
    }
  }
  return { toolName };
}

// ---------- 登记表 ----------

export function createPluginActions(): PluginActions {
  const entries = new Map<string, ActionRecord>();

  const toInfo = (r: ActionRecord): ActionInfo => ({
    name: r.name,
    owner: r.pluginId,
    scope: r.reach,
    reverse: r.reverse,
    service: r.service,
    hasTool: r.tool !== undefined,
    http: r.httpPath ?? null,
    hasParams: r.params !== undefined,
  });

  return {
    define(pluginId, actions) {
      if (isReservedPluginId(pluginId)) {
        return {
          ok: false,
          reason: 'reserved-plugin-id',
          error: `插件 id『${pluginId}』占用保留命名空间（__x__ 不可用）`,
        };
      }
      if (!isPlainObject(actions)) return { ok: false, reason: 'not-an-object', error: 'define 的入参必须是 { 动作名: 定义 } 对象' };
      const names = Object.keys(actions);
      if (names.length === 0) return { ok: false, reason: 'empty', error: 'define 的动作集合为空' };

      // ── 阶段一：整批校验（不改任何状态）──
      const staged: ActionRecord[] = [];
      const seenToolNames = new Map<string, string>();
      for (const action of names) {
        const def = actions[action]!;
        const res = checkOne(pluginId, action, def);
        if (res.error) {
          logger.error({ pluginId, action, reason: res.error.reason }, res.error.message);
          return { ok: false, reason: res.error.reason, error: res.error.message };
        }
        const name = pluginMethodName(pluginId, action);
        if (entries.has(name) || staged.some((r) => r.name === name)) {
          const msg = `动作『${action}』已存在（${name}）`;
          logger.error({ pluginId, action }, msg);
          return { ok: false, reason: 'duplicate', error: msg };
        }
        if (res.toolName) {
          const other = seenToolNames.get(res.toolName);
          if (other) {
            const msg = `工具名『${res.toolName}』在本插件内重复（动作 ${other} 与 ${action}）`;
            logger.error({ pluginId, action }, msg);
            return { ok: false, reason: 'tool-name-duplicate', error: msg };
          }
          seenToolNames.set(res.toolName, action);
        }

        const wantsTool = def.tool !== undefined && def.tool !== null;
        const wantsHttp = def.http !== undefined && def.http !== null;
        const toolDef = wantsTool ? (def.tool as PluginActionToolExposure) : undefined;
        staged.push({
          pluginId,
          action,
          name,
          params: def.params,
          handler: def.handler,
          reverse: def.reverse !== false,
          reach: def.scope === 'public' ? 'public' : 'own',
          service: def.service === true,
          ...(def.namespace ? { namespace: def.namespace } : {}),
          tool: toolDef
            ? {
                name: toolDef.name ?? defaultToolName(pluginId, action),
                description: toolDef.description,
                exposure: toolDef.exposure ?? 'deferred',
                namespace: toolDef.namespace ?? pluginId,
                ...(toolDef.annotations ? { annotations: toolDef.annotations } : {}),
                ...(toolDef.promptSnippet ? { promptSnippet: toolDef.promptSnippet } : {}),
                ...(toolDef.promptGuidelines ? { promptGuidelines: toolDef.promptGuidelines } : {}),
              }
            : undefined,
          httpPath: wantsHttp
            ? ((def.http as { path?: string }).path ?? defaultHttpPath(action))
            : undefined,
        });
      }

      // ── 阶段二：全部合法才落表（"整批不注册"由此保证）──
      for (const rec of staged) entries.set(rec.name, rec);
      logger.debug(
        { pluginId, actions: staged.map((r) => r.name) },
        `define: ${staged.length} 个动作（reverse ${staged.filter((r) => r.reverse).length} / service ${staged.filter((r) => r.service).length} / tool ${staged.filter((r) => r.tool).length} / http ${staged.filter((r) => r.httpPath).length}）`,
      );
      return { ok: true, accepted: staged };
    },

    resolve(name) {
      return entries.get(name);
    },

    reachOf(name) {
      return entries.get(name)?.reach;
    },

    descriptorsFor(pluginIds) {
      const wanted = new Set(pluginIds);
      return [...entries.values()]
        .filter((r) => wanted.has(r.pluginId) && r.tool)
        .map((r) => ({ action: r.action, params: r.params ?? {}, tool: r.tool! }))
        .sort((a, b) => a.tool.name.localeCompare(b.tool.name));
    },

    descriptorsOf(pluginId) {
      return this.descriptorsFor([pluginId]);
    },

    list() {
      return [...entries.values()].map(toInfo).sort((a, b) => a.name.localeCompare(b.name));
    },

    listOf(pluginId) {
      return this.list().filter((a) => a.owner === pluginId);
    },

    disposePlugin(pluginId) {
      for (const [name, rec] of entries) {
        if (rec.pluginId === pluginId) entries.delete(name);
      }
    },

    count() {
      return entries.size;
    },

    clear() {
      entries.clear();
    },
  };
}

// ---------- 进程内单例 ----------

let singleton: PluginActions | null = null;

/**
 * 进程内唯一实例。
 *
 * 为什么是模块级单例而不是注入：这张表被两条互不相识的路径读 ——
 * 插件运行期（`buildHost().actions.define`）与 spawn 前的会话装配（`buildRuntimeConfig`）。
 * 与 `sessionRegistry` / `coreConfig` 同款处理，避免"两处各 new 一个，spawn 时永远是空表"。
 */
export function pluginActions(): PluginActions {
  return (singleton ??= createPluginActions());
}

/** 测试/重载用：丢掉单例（已登记的记录随之消失）。 */
export function resetPluginActions(): void {
  singleton = null;
}
