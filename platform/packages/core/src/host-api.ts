/**
 * 宿主 API surface —— 插件与内核之间的**唯一稳定缝**。
 *
 * 为什么需要它：插件最终要访问内核（读会话、建自己的表、改 agent 配置、订阅生命周期），
 * 但它们不能 import 内核内部模块 —— 那样每次内核重构都会打断插件，且插件间可以互相
 * 穿透。把能力收敛成四个面之后，内核内部怎么改都不影响插件契约。
 *
 * 为什么是四个（change: plugin-mechanism-v2 / D2）：
 * - 旧 `web` 面（`assetBasePath`）本质是"入口怎么托管资源"，属 HTTP 接入层，内核不该知道
 * - 旧 `events` 面只有一个 `maxPayloadBytes` 常量，是出口限流参数，不构成能力；
 *   插件侧的 `events.emit` 在入口/worker 侧实现
 * - 旧 `outbound` 面是"反向方法注册"，属**注册面**而非能力面，归装载器内部
 * - 新增 `agents`：插件要维护自己的配置块就得读写 agent
 *
 * 只声明形状，实现在组合根完成（内核不替入口决定"暴露到什么程度"）。
 * `WorkerPool` 明确**不作为面暴露**：暴露 = 插件能决定杀进程/超卖并发；
 * 需要"活跃会话"信息的地方用 `sessions.list/status`。
 */

import type { AgentDTO } from '@pi-agent-platform/shared-types';
import type { WorkerEvent } from '@pi-agent-platform/ipc-protocol';

/** 数据面：迁移登记 + 查询。读写都开放（插件完全可信，每次 query 进审计日志）。 */
export interface HostDbApi {
  /**
   * 执行一段幂等 DDL 并**登记表归属**（卸载时用于提示"留下的表"）。
   *
   * 内核只建内核对象的表（agents / sessions / attachments），模块与插件的表自己建。
   */
  migrate(name: string, ddl: string): void;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
}

/** 会话摘要（比 DTO 小：插件只需要"有哪些会话、什么状态"）。 */
export interface HostSessionSummary {
  id: string;
  agentId?: string;
  /** `missing` = 无运行态对象；`idle` / `running` 来自会话运行态。 */
  status: string;
  /** 是否已有 DB 行（placeholder 为 false）。 */
  hasRow: boolean;
}

/** 会话能力面 —— 插件对"某个会话做一件事"的唯一入口。 */
export interface HostSessionsApi {
  /**
   * 调一个方法。`prompt` / `abort` 这类平台方法名前带 `plugin.<id>.` 的是插件自己的。
   *
   * `sessionId` **永远由调用方给**：宿主不提供"选会话"语义，会话映射归插件自己维护。
   * 注意：这条路径是**裸 worker 方法调用**，不过 prompt-resolver（斜杠命令 / 附件占位符）。
   */
  call<T = unknown>(sessionId: string, method: string, args?: unknown[]): Promise<T>;
  get(sessionId: string): HostSessionSummary | null;
  list(): HostSessionSummary[];
  /** `missing` / `idle` / `running`。 */
  status(sessionId: string): string;
  /** 该会话是否存在 DB 行。 */
  hasRow(sessionId: string): boolean;
  /** 订阅某个会话的原生事件流；返回幂等退订。 */
  subscribe(sessionId: string, listener: (event: WorkerEvent) => void, onDispose?: (reason: string) => void): () => void;
  /**
   * 取一个**可用**的会话（无人值守跑一轮的入口）。
   *
   * 三态，与旧版 `resolveSession()` 一致：
   * - 不给 `sessionId`：新建会话（`createFromAgent` → 落行）→ `created: true`
   * - 给 `sessionId`：必须已存在且属于该 agent → 懒恢复 → `created: false`
   * - 给的 id 不存在 / 属于别的 agent：**抛错**（fail closed，绝不"照建一个"写错地方）
   */
  ensure(input: HostEnsureSessionInput): Promise<HostEnsureSessionResult>;
  /**
   * 把一条**非用户消息**（`<system-event>` 信封）交给会话。
   *
   * 信封文本由内核唯一构造，插件只给结构化字段 —— 不可信输入因此永远进不到
   * 标签名 / 属性里。**返回即"送到"**：不等待 agent 跑完，也不判断它干得怎么样。
   */
  systemEvent(input: HostSystemEventInput): Promise<void>;
}

/** `sessions.ensure` 入参。 */
export interface HostEnsureSessionInput {
  agentId: string;
  /** 复用目标。不给 = 新建。 */
  sessionId?: string;
  /** 只在新建时生效（会话标题，用于归因）。 */
  title?: string;
}

/** `sessions.ensure` 结果。 */
export interface HostEnsureSessionResult {
  sessionId: string;
  created: boolean;
}

/** `sessions.systemEvent` 入参。 */
export interface HostSystemEventInput {
  sessionId: string;
  /** 信封判别字段（`trigger` / `reminder` / `system` / 自定义）。 */
  kind: string;
  /** 机器可读来源。 */
  source?: string;
  /** 人可读短名。 */
  name?: string;
  /** run / 事件 id，便于日志与台账交叉引用。 */
  run?: string;
  /** 正文（进 `<instruction>`）。 */
  instruction?: string;
  /** 附加上下文（进 `<data format="json">`）。 */
  data?: unknown;
  /**
   * agent 正在跑（流式输出中）时怎么办 —— 原样交给 pi 的 `prompt`：
   * - `followUp`：排队，等当前轮结束再送（不丢事件）
   * - `steer`：当前轮工具调用结束后插入（会打断 agent 正在做的事）
   * - 不传：pi 直接报错（"already streaming"），调用方自己负责拦
   *
   * 语义由调用方（插件）按业务定：定时任务的 `busy_policy`、webhook 的同名字段。
   */
  streamingBehavior?: 'steer' | 'followUp';
}

/**
 * 进程内事件总线（插件之间的唯一协作通道）。
 *
 * 为什么不叫 `events`：`host.events` 已经被占用（worker → server → SSE 的事件出口）。
 * 这一面是**给别的插件**的广播，名字必须能区分开。
 */
export interface HostBusApi {
  /** 发布。无回执、同步派发、无订阅者时静默丢弃。 */
  publish(topic: string, payload?: unknown): void;
  /** 订阅。返回幂等退订（进插件 disposer 账本）。 */
  subscribe(topic: string, listener: (payload: unknown) => void): () => void;
}

/** agent 配置能力面。 */
export interface HostAgentsApi {
  list(): AgentDTO[];
  get(agentId: string): AgentDTO | null;
  /** 部分更新（`id` / `createdAt` 不可改）。不存在时抛错。 */
  update(agentId: string, patch: Partial<Omit<AgentDTO, 'id' | 'createdAt'>>): void;
}

/** 生命周期钩子（会话创建 / 终结）。 */
export interface HostLifecycleApi {
  onSessionCreated(hook: (sessionId: string, agentId: string) => void): () => void;
  onSessionDisposed(hook: (sessionId: string, reason: string) => void): () => void;
}

/** 插件拿到的宿主 API（四个能力面）。 */
export interface HostApi {
  readonly db: HostDbApi;
  readonly sessions: HostSessionsApi;
  readonly agents: HostAgentsApi;
  readonly lifecycle: HostLifecycleApi;
  /**
   * 插件间协作（进程内事件总线）。
   *
   * 为什么是能力面而不是注册面：发布方与订阅方**互不认识**，内核只是那个交汇点；
   * 没有"注册一个方法给别人调"这种方向性，所以它不归装载器。
   */
  readonly bus: HostBusApi;
}
