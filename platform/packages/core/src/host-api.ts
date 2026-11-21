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
   * 调一个方法。`prompt` / `abort` 是内核方法（线上名 `__core__.prompt`，短名由 `call` 补全）；
   * 带点的名字（`<pluginId>.<name>`）由插件自己注册。
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

  // ── 会话管理（admin 类插件用：原 capabilities 的行为搬到这里）──
  //
  // 为什么这些方法在宿主面而不是让插件自己拼：它们各自跨了 worker + DB 两处
  // （model/thinkingLevel 要 IPC+DB 双写、restart 要 kill+respawn、title 要走共享改名语义）。
  // 插件只有 `db.query`，自己拼就会漏掉"worker 活着时立即生效"那一半。
  /** 完整会话行（含 config）+ worker 存活标记；不存在返回 null。 */
  detail(sessionId: string): (SessionDTO & { workerAlive: boolean }) | null;
  /** 组合过滤（AND）：`agentId` 精确 / `title` 子串 / `status`。 */
  find(filter?: { agentId?: string; title?: string; status?: 'active' | 'archived' }): Array<SessionDTO & { workerAlive: boolean }>;
  /** 局部更新。生效时机与 HTTP 路由完全一致（同一份实现）。 */
  update(
    sessionId: string,
    patch: { title?: string; model?: string; thinkingLevel?: 'off' | 'low' | 'medium' | 'high'; config?: AgentConfig },
  ): Promise<SessionDTO & { workerAlive: boolean }>;
  /** 优雅 kill → 立即重建并复用 `piSessionPath`。busy 时抛错（不 kill）。 */
  restart(sessionId: string): Promise<{ restarted: true; workerPid: number; historyRestored: true }>;
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
 * 进程内广播总线（插件之间的**广播**通道）。
 *
 * 为什么不叫 `events`：`host.events` 已经被占用（worker → server → SSE 的事件出口）。
 * 这一面是**给别的插件**的广播，名字必须能区分开。
 *
 * 注意：这一层的签名**带 `pluginId`**（注册表形态，身份显式）；插件拿到的是
 * `buildHost()` 包装后的绑定版（不需要传 id）。owner 管控必须在注册表这一层做，
 * 否则插件可以自己伪造身份。
 */
export interface HostBusApi {
  declare(
    pluginId: string,
    topic: string,
    options: { declaredBy: TopicDeclarer },
  ): { ok: boolean; reason?: string };
  publish(pluginId: string, topic: string, payload?: unknown): PublishResult;
  publishAndWait(
    pluginId: string,
    topic: string,
    payload?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<PublishAndWaitResult>;
  subscribe(
    pluginId: string,
    topic: string,
    listener: (payload: unknown) => void,
  ): { dispose: () => void; state: 'matched' | 'pending' };
  topics(): TopicInfo[];
  topicsOf(pluginId: string): TopicInfo[];
  disposePlugin(pluginId: string): void;
}

/** 插件间定向调用（恰好一个提供者、返回业务数据）。 */
export interface HostServicesApi {
  provide(
    pluginId: string,
    name: string,
    handler: (payload: unknown, meta: { pluginId: string }) => unknown | Promise<unknown>,
  ): { ok: boolean; reason?: string };
  call(
    callerPluginId: string,
    name: string,
    payload?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<unknown>;
  list(): ServiceInfo[];
  listOf(pluginId: string): ServiceInfo[];
  disposePlugin(pluginId: string): void;
}

/**
 * 动作面（一份 handler + 五个暴露字段）—— 注册表形态，带 owner 的 `pluginId`。
 *
 * 这里只做「校验 + 记账」：反向方法 / service / 工具描述符 / HTTP 路由这四类产物由
 * `plugin-extensions.ts` 的 `buildHost()` 投影（它已经持有那三张表）。
 */
export interface HostActionsApi {
  /** 登记一组动作；任何一条不合法 → 整批不登记并返回错误。 */
  define(pluginId: string, actions: Record<string, PluginActionDefinition>): DefineResult;
  /** 全名（`<pluginId>.<action>`）→ 记录。 */
  resolve(name: string): ActionRecord | undefined;
  /** 全名 → 可达性（`own` / `public`），worker-pool 的归属校验用。 */
  reachOf(name: string): ActionReach | undefined;
  /** 给 worker 的工具描述符（按会话启用的插件过滤）。 */
  descriptorsFor(pluginIds: readonly string[]): ActionToolDescriptor[];
  descriptorsOf(pluginId: string): ActionToolDescriptor[];
  list(): ActionInfo[];
  listOf(pluginId: string): ActionInfo[];
  disposePlugin(pluginId: string): void;
  count(): number;
  clear(): void;
}

/** agent 配置能力面。 */
export interface HostAgentsApi {
  list(): AgentDTO[];
  get(agentId: string): AgentDTO | null;
  /** 部分更新（`id` / `createdAt` 不可改）。不存在时抛错。 */
  update(agentId: string, patch: Partial<Omit<AgentDTO, 'id' | 'createdAt'>>): void;
}

/** 生命周期钩子（会话创建 / 终结）+ 只读运行态快照。 */
export interface HostLifecycleApi {
  onSessionCreated(hook: (sessionId: string, agentId: string) => void): () => void;
  onSessionDisposed(hook: (sessionId: string, reason: string) => void): () => void;
  /**
   * 进程运行态**快照**（纯数据：版本 / uptime / 端口 / worker 池统计）。
   *
   * 为什么不给 `workerPool` 句柄：插件需要的是"现在几个 worker 在跑"，不是"能 kill 谁"。
   * 句柄一给，`host` 就不再是"唯一通道"（见 invariant：插件不得拿资源管理器）。
   */
  runtime(): {
    version: string;
    uptimeMs: number;
    nodeEnv: string;
    port: number;
    pid: number;
    workers: { active: number; placeholders: number; max: number; pendingCalls: number };
  };
}

import type {
  PublishAndWaitResult,
  PublishResult,
  TopicDeclarer,
  TopicInfo,
} from './services/event-bus.js';
import type { ServiceInfo } from './services/plugin-services.js';
import type {
  ActionInfo,
  ActionReach,
  ActionRecord,
  ActionToolDescriptor,
  DefineResult,
} from './services/plugin-actions.js';
import type { PluginActionDefinition } from '@pi-agent-platform/plugin-types';
import type { AgentConfig, SessionDTO } from '@pi-agent-platform/shared-types';

/**
 * 入口实现的宿主能力面（注册表形态，所有方法带调用方/声明方的 `pluginId`）。
 *
 * 插件本身看到的不是这个对象：`plugin-extensions.ts` 的 `buildHost()` 会包一层，把
 * 身份绑定进去并挂 disposer 账本 —— 那是 owner 管控与卸载归零的唯一实现点。
 */
export interface HostApi {
  readonly db: HostDbApi;
  readonly sessions: HostSessionsApi;
  readonly agents: HostAgentsApi;
  readonly lifecycle: HostLifecycleApi;
  /** 插件间协作：**广播**（0..n 订阅者、无业务返回值）。 */
  readonly bus: HostBusApi;
  /** 插件间协作：**定向调用**（恰好一个提供者、返回业务数据）。 */
  readonly services: HostServicesApi;
  /** 动作登记表：一份 handler → 反向 / service / tool / http 四个投影。 */
  readonly actions: HostActionsApi;
}
