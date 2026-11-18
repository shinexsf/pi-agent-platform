/**
 * 宿主 API surface —— 插件与内核之间的**唯一稳定缝**。
 *
 * 为什么需要它：插件最终要访问内核（建会话、读写自己的表、注册反向方法、发事件），
 * 但它们不能 import 内核内部模块 —— 那样每次内核重构都会打断插件，且插件间可以互相
 * 穿透。把能力收敛成六个面之后，内核内部怎么改都不影响插件契约。
 *
 * 为什么是六个：每个面回答一类问题，且缺一个插件就得自己造轮子。
 * 只声明形状，实现在组合根完成（内核不替入口决定"暴露到什么程度"）。
 */

import type { WorkerEvent } from '@pi-agent-platform/ipc-protocol';

/** 模块自带表的迁移入口（内核只建内核对象的表）。 */
export interface HostDbApi {
  /** 执行一段幂等 DDL / 迁移。 */
  executeMigration(name: string, ddl: string): void;
}

/** 会话生命周期与会话级订阅。 */
export interface HostSessionsApi {
  /** 该会话是否存在 DB 行。 */
  hasRow(sessionId: string): boolean;
  /** 订阅某个会话的原生事件流；返回幂等退订。 */
  subscribe(sessionId: string, listener: (event: WorkerEvent) => void, onDispose?: (reason: string) => void): () => void;
}

/** 生命周期钩子（会话创建 / 终结）。 */
export interface HostLifecycleApi {
  onSessionCreated(hook: (sessionId: string, agentId: string) => void): () => void;
  onSessionDisposed(hook: (sessionId: string, reason: string) => void): () => void;
}

/** 反向方法注册（worker → 宿主）。 */
export interface HostOutboundApi {
  registerService(
    source: `plugin:${string}`,
    kind: 'plugin',
    handlers: Record<string, (sessionId: string, args: unknown[]) => Promise<unknown>>,
  ): void;
}

/** 插件事件的上行约束（大小 / 频率由入口侧执行，内核只给出口）。 */
export interface HostEventsApi {
  /** 单条插件事件的载荷上限（字节）。 */
  readonly maxPayloadBytes: number;
}

/** 界面挂载能力：内核只存数据，不做 HTTP。 */
export interface HostWebApi {
  /** 插件 web 资源的同源前缀（由入口决定怎么托管）。 */
  assetBasePath(pluginId: string): string;
}

/** 插件拿到的宿主 API。 */
export interface HostApi {
  readonly db: HostDbApi;
  readonly sessions: HostSessionsApi;
  readonly lifecycle: HostLifecycleApi;
  readonly outbound: HostOutboundApi;
  readonly events: HostEventsApi;
  readonly web: HostWebApi;
}
