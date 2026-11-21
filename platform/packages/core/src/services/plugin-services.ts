/**
 * 插件间**定向调用**（service）—— 进程内、恰好一个提供者、返回业务数据。
 *
 * 与广播总线（`event-bus.ts`）的区别，只在这四点：
 *
 * | | bus（广播） | services（调用） |
 * |---|---|---|
 * | 定向 | 否（0..n 订阅者） | **是**（恰好 1 个提供者） |
 * | 返回 | 只回报成败（handler 返回值被丢弃） | **业务数据** |
 * | 缺失 | 正常态（delivered:0） | **错误**（`unknown service`） |
 * | 抛错 | 吞掉，只计数 | **透传给调用方** |
 *
 * 与 `host.methods`（反向 IPC 表）的区别：那边面向**本会话 worker**，签名带 `sessionId`，
 * 且天然是私有的（worker 只跟自己插件的 server facet 说话）。这一面面向**其他插件**，
 * 无会话上下文。两者 MUST NOT 复用同一张表。
 *
 * 命名：MUST 是 `<pluginId>.<资源>.<动作>`，前缀 MUST 等于提供者 id。
 * 不做：payload schema 校验（形状由 spec 固定，缺字段由 handler 自己抛错）、跨进程。
 */

import { childLogger } from '../logger.js';

const logger = childLogger('plugin-services');

export type ServiceFailure = 'not-owner' | 'duplicate';

export interface ServiceInfo {
  name: string;
  owner: string;
}

/** 调用方信息：`services.call` 时由宿主填，提供者只读。 */
export interface ServiceCallerMeta {
  pluginId: string;
}

export type ServiceHandler = (
  payload: unknown,
  meta: ServiceCallerMeta,
) => unknown | Promise<unknown>;

interface ProviderEntry {
  name: string;
  owner: string;
  handler: ServiceHandler;
}

export interface PluginServices {
  /** 声明一个服务。前缀不符 → `not-owner`；同名已存在 → `duplicate`。 */
  provide(pluginId: string, name: string, handler: ServiceHandler): { ok: boolean; reason?: ServiceFailure };
  /** 定向调用：返回业务数据；缺失/超时/提供者抛错都会抛给调用方。 */
  call(callerPluginId: string, name: string, payload?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  /** 目录：全部已提供的服务。 */
  list(): ServiceInfo[];
  /** 某插件提供的服务（查询面用）。 */
  listOf(pluginId: string): ServiceInfo[];
  /** 卸载兜底：撤销该插件的全部服务。 */
  disposePlugin(pluginId: string): void;
  count(): number;
  clear(): void;
}

const DEFAULT_CALL_TIMEOUT_MS = 5_000;

function hasOwnerPrefix(pluginId: string, name: string): boolean {
  return name.startsWith(`${pluginId}.`) && name.length > pluginId.length + 1;
}

export function createPluginServices(): PluginServices {
  const providers = new Map<string, ProviderEntry>();

  return {
    provide(pluginId, name, handler) {
      if (!hasOwnerPrefix(pluginId, name)) {
        logger.error({ pluginId, name }, 'services.provide rejected: 名字必须以「插件 id.」为前缀');
        return { ok: false, reason: 'not-owner' };
      }
      if (typeof handler !== 'function') {
        logger.error({ pluginId, name }, 'services.provide rejected: handler 必须是函数');
        return { ok: false, reason: 'not-owner' };
      }
      const existing = providers.get(name);
      if (existing) {
        logger.error({ pluginId, name, owner: existing.owner }, 'services.provide rejected: 同名服务已存在');
        return { ok: false, reason: 'duplicate' };
      }
      providers.set(name, { name, owner: pluginId, handler });
      return { ok: true };
    },

    async call(callerPluginId, name, payload, options) {
      const entry = providers.get(name);
      if (!entry) {
        logger.debug({ caller: callerPluginId, name }, 'services.call: unknown service');
        throw new Error(`unknown service: ${name}`);
      }
      const timeoutMs = options?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
      const TIMEOUT = Symbol('timeout');

      const result = await Promise.race([
        Promise.resolve().then(() => entry.handler(payload, { pluginId: callerPluginId })),
        new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), timeoutMs)),
      ]);

      if (result === TIMEOUT) {
        // 超时不取消：handler 仍在跑（进程内无取消原语），契约里写明
        logger.warn({ caller: callerPluginId, name, timeoutMs }, 'services.call: 超时（未取消 handler）');
        throw new Error(`service timeout: ${name}`);
      }
      return result;
    },

    list() {
      return [...providers.values()]
        .map(({ name, owner }) => ({ name, owner }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    listOf(pluginId) {
      return this.list().filter((s) => s.owner === pluginId);
    },

    disposePlugin(pluginId) {
      for (const [name, entry] of providers) {
        if (entry.owner === pluginId) providers.delete(name);
      }
    },

    count() {
      return providers.size;
    },

    clear() {
      providers.clear();
    },
  };
}
