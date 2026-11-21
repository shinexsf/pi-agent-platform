/**
 * 插件契约类型（骨架）。
 *
 * 这里只放"插件作者需要 import 的形状"与"平台内部传递的形状"，不放任何实现。
 *
 * 命名约定：四类 facet 按"跑在哪"命名
 * - `server`    server 进程（hono），拿到 `PluginServerHost`
 * - `worker`    worker 进程，拿到 `PluginWorkerBridge`
 * - `extension` worker 进程内的 **pi 扩展系统**，拿到 pi 的 ExtensionAPI
 * - `web`       浏览器，拿到 `PluginWebHost`
 *
 * 不变量（实现时不得破坏）：
 * 1. 浏览器侧数据只能经由 worker → server → SSE 单向上行；server 不提供推送 API
 * 2. `requires.plugins` 只做校验，不代替用户启用任何 pi 插件
 * 3. 边界两侧只交换普通 JSON、回调与 DOM 节点（不交换响应式对象 / 组件 / VNode）
 */

/**
 * 当前平台契约版本。
 *
 * 本包是 **types-only**：这里只有类型，没有任何运行期导出。
 * 平台侧的常量（`PLUGIN_API_VERSION` / facet 名单 / 槽位白名单）在
 * `@pi-agent-platform/core/plugins`；插件不看它们，插件在自己的默认导出里
 * 声明 `apiVersion: '1'`，装载器读到后与平台常量比对。
 */
export type PluginApiVersion = '1';

/**
 * **类型声明版本**（vendored 交付用）。
 *
 * 与 `apiVersion` 不是一回事：`apiVersion` 是插件声明"我按哪版契约写的"，
 * 这个是"这份 `.d.ts` 是哪版"。`plugin check` 拿它和平台常量比对 ——
 * 防止插件目录里躺着一份过期类型，作者照着它写却在运行期撞形状不符。
 */
export declare const PLUGIN_TYPES_VERSION: '1';

/** facet 名 = 目录名。目录存在即声明该 facet。 */
export type PluginFacetName = 'server' | 'worker' | 'extension' | 'web';

/**
 * 插件状态。
 * - `active`   全部已启用 facet 就绪
 * - `degraded` 能加载但有降级原因（依赖版本不符、某 facet 加载失败）
 * - `disabled` 用户显式停用（目录保留）
 * - `pending`  变更待下次 spawn 生效（worker / extension facet）
 * - `orphan`   目录存在但 `registry.json` 未登记（不加载）
 */
export type PluginStatus = 'active' | 'degraded' | 'disabled' | 'pending' | 'orphan';

/** UI 槽位名。宿主实现这些槽位，插件向其中注册。 */
/**
 * 插件可以挂载的 UI 槽位。
 *
 * 一个槽位 = **一个完整的界面入口**，不是“一个渲染位置”：
 * - `chat.rail.right` —— 会话页右侧 icon 轨道上的一个按钮 **及其抽屉面板**：
 *   声明一次，宿主渲染按钮，点开就是用该 surface 的 `entry` 加载的面板内容。
 *
 * 目前只有右侧轨道。未来若加左侧轨道，命名沿用同一规则（`chat.rail.left`），
 * 并且抽屉同样是槽位的一部分，不需要再单独声明 `chat.drawer.*`。
 */
export type PluginSlotName = 'chat.rail.right';

/**
 * facet 在当前平台的装载支持度。
 *
 * - `loaded`        平台会真的执行它（`server`/`worker`/`extension`/`web` 都有装载实现）
 * - `declared-only` 只有契约与目录探测，**没有装载实现**
 *
 * 这个映射是目录页"扩展点是否可用"的唯一依据：不允许用"目录存在"冒充"可用"。
 */
export type FacetSupport = 'loaded' | 'declared-only';

/** 某个 facet 的入口文件探测结果。 */
export interface FacetEntryPoint {
  /** 实际采用的路径（探测成功时为命中的候选，失败时为第一个期望路径）。 */
  path: string;
  exists: boolean;
  /** 按顺序探测过的候选路径，便于在 UI 上解释"为什么说缺失"。 */
  candidates: string[];
}

/** `package.json` 里 `piServer` 字段的形状。 */
export interface PluginPackageManifest {
  /** 平台契约版本；缺失视为不兼容，整包跳过。 */
  apiVersion: string;
  /**
   * 依赖的 pi 原生插件（包名 → semver range）。
   * 必须同时出现在 `peerDependencies` 中（代码要 import）。
   * 语义是"校验"：未安装或未在该 agent 的 `extensions` 白名单启用 → 不加载，绝不代勾。
   */
  requires?: { plugins?: Record<string, string> };
  // web 槽位不再声明：界面贡献一律来自 web/index.js 的 `register(host)` 运行期注册。
}

/** 从 `package.json` 解析出的插件清单。 */
export interface PluginManifest {
  /** 插件 id = npm 包名。 */
  name: string;
  version: string;
  apiVersion: string;
  requiresPlugins: Record<string, string>;
  /** 面向人的说明（`package.json` 顶层 `description`）；缺失即 undefined，不补默认值。 */
  description?: string;
  /** `package.json` 顶层 `author`（字符串或 `{ name }` 均可，归一为字符串）。 */
  author?: string;
  /** `package.json` 顶层 `homepage`。 */
  homepage?: string;
}

/**
 * `registry.json` 的单个条目 —— **只有三行**（安装台账，不是描述文件）。
 *
 * 版本、描述、facet 声明一律来自插件自己的代码与目录，registry 不重复记录：
 * 重复记录就会在升级/改代码后过期，然后出现"台账说的和实际跑的不一致"。
 */
export interface PluginRegistryEntry {
  id: string;
  /** 安装目录绝对路径。 */
  dir: string;
  /** 默认启用；`false` 时任何 facet 都不加载。 */
  enabled: boolean;
}

/**
 * 卸载墓碑。
 *
 * bundled 插件以"目录存在即生效"为准，所以卸载它必须留下**持久证据**，
 * 否则下次启动扫目录又装回来了。升级不清墓碑（升级换的是目录，不是用户意愿）。
 */
export interface RemovedPluginEntry {
  id: string;
  /** ISO 字符串。 */
  removedAt: string;
}

/** `registry.json` 根结构（v2）。v1 的读写由内核侧自动迁移。 */
export interface PluginRegistryFile {
  version: 2;
  plugins: PluginRegistryEntry[];
  removed: RemovedPluginEntry[];
}

/**
 * 会话级解析结果，随 spawn 参数下发。
 * `enabled: false` 时 worker 只记录 `reason`，不执行任何 import。
 */
export interface ResolvedPlugin {
  id: string;
  dir: string;
  enabled: boolean;
  reason?: string;
  /** `<dir>/extension/index.js` 存在且启用时才有。 */
  extensionPath?: string;
  /** `<dir>/worker/index.js` 存在且启用时才有。 */
  workerPath?: string;
  /** 插件自带的 skill 目录（`<dir>/skills/<name>`），与工具同源生效。 */
  skillPaths?: string[];
}

/** 插件向宿主注册的 UI 槽位（= 一个完整界面入口：按钮 + 打开后的内容）。 */
export interface SurfaceRegistration {
  /** 槽位标识，同槽位内唯一；重复注册后者被拒绝。 */
  id: string;
  slot: PluginSlotName;
  /** 浏览器入口文件名（不含 `.js`），对应 `web/<entry>.js`。 */
  entry: string;
  title: string;
  /** 图标标识，由宿主解析；缺省时宿主用默认图标。 */
  icon?: string;
  /** 同一槽位内的排序，小者靠前。 */
  order?: number;
}

/** 插件注册的一级菜单项。 */
export interface MenuRegistration {
  id: string;
  label: string;
  icon?: string;
  /** 一级菜单按此排序，小者靠前；缺省排在内置项之后。 */
  order?: number;
  /** 二级挂载点；本期只开放 `config`。 */
  parent?: PluginMenuParent;
  /** 引用 `PageRegistration.id`，点击后渲染该页面。 */
  page: string;
}

export type PluginMenuParent = 'config';

/** 插件页面：菜单点击后渲染的内容。 */
export interface PageRegistration {
  id: string;
  /** 浏览器入口文件名（不含 `.js`），对应 `web/<entry>.js`。 */
  entry: string;
  /**
   * 页面自己的 URL 路径（`ui.page` 会填）。旧式插件没有，前端退回
   * `/plugin-page/<pluginId>/<pageId>` —— 两条路由都由前端登记。
   */
  path?: string;
}

/** 插件 HTTP 端点的请求视图（`path` 已剥掉 `/api/p/<pluginId>` 前缀）。 */
export interface PluginRouteRequest {
  method: string;
  /** **原始**路径（剥前缀后），不做归一化 —— 插件自己分发。 */
  path: string;
  /** `:param` 段解出来的值（`*` 通配段整体放在 `'*'` 键下）。 */
  params: Record<string, string>;
  query: Record<string, string>;
  /** 原始 body 文本（JSON 需插件自行 `JSON.parse`，平台不做猜测）。 */
  body: string;
  header(name: string): string | undefined;
}

/** 插件 HTTP 端点的响应。缺省为 200 + JSON 空对象。 */
export interface PluginRouteResponse {
  status?: number;
  headers?: Record<string, string>;
  /** 与 `body` 二选一；同时给出时 `body` 优先。 */
  json?: unknown;
  body?: string | Uint8Array;
}

export type PluginRouteHandler = (
  req: PluginRouteRequest,
) => PluginRouteResponse | void | Promise<PluginRouteResponse | void>;

/** 插件注册的 HTTP 端点（挂在 `/api/p/<pluginId>/` 下）。 */
export interface RouteRegistration {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /**
   * 以 `/` 开头。支持两种段级模式：
   * - `:name`  匹配单段，值进 `request.params.name`
   * - `*`      只能作为**最后一段**，匹配剩余全部（值进 `request.params['*']`）
   */
  path: string;
  handler: PluginRouteHandler;
}

/** 工具卡片替换模式：整卡替换，或只替换指定区域。 */
export type ToolCardMode = 'replace' | 'regions';

/** 工具卡片可被替换的区域。 */
export type ToolCardRegion = 'header' | 'body' | 'footer';

/** 插件对工具卡片的接管声明。 */
export interface ToolCardRegistration {
  /** 工具名；`match: 'prefix'` 时可写 `mcp__xx__` 这类前缀。 */
  tool: string;
  match?: 'exact' | 'prefix';
  mode: ToolCardMode;
  /** `mode: 'replace'` 必填：整卡渲染入口（`web/<entry>.js`）。 */
  entry?: string;
  /** `mode: 'regions'` 必填：区域 → 入口文件。 */
  regions?: Partial<Record<ToolCardRegion, string>>;
}

/** 被拒绝的注册项（绝不静默丢弃）。 */
export interface RejectedRegistration {
  kind: 'menu' | 'page' | 'route' | 'surface' | 'toolCard' | 'method' | 'headerAction';
  /** 被拒项的自报标识（可能重复，故意的）。 */
  id: string;
  reason: string;
}

/** 单个插件的运行期注册结果。 */
export interface PluginExtensions {
  menus: MenuRegistration[];
  pages: PageRegistration[];
  /** R11 顶栏动作（全局 chrome，与会话无关）。 */
  headerActions: HeaderActionDefinition[];
  /** handler 不序列化，只暴露 method/path。 */
  routes: Array<{ method: RouteRegistration['method']; path: string }>;
  surfaces: SurfaceRegistration[];
  toolCards: ToolCardRegistration[];
  rejected: RejectedRegistration[];
  /** `register()` / `init()` 抛错或超时时的说明。 */
  registerError?: string;
}

/**
 * 注册入口的宿主接口。
 *
 * - `register(host)` 用 `global.{menus,pages}` 与 `session.{surfaces,toolCards}`
 * - `init(host)` 用 `global.routes`
 * 两组命名空间是硬边界：`global` 下的东西与会话无关，`session` 下的只对会话有意义。
 */
export interface PluginRegistrationHost {
  readonly id: string;
  /** 插件安装目录（绝对路径），便于插件自己读写文件。 */
  readonly dir: string;
  readonly global: {
    menus: { register(def: MenuRegistration): void };
    pages: { register(def: PageRegistration): void };
    routes: { register(def: RouteRegistration): void };
  };
  readonly session: {
    surfaces: { register(def: SurfaceRegistration): void };
    toolCards: { register(def: ToolCardRegistration): void };
  };
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void;
}

/** server facet 入口签名（`server/index.js` 默认导出）。 */
export type PluginServerInit = (host: PluginRegistrationHost) => void | Promise<void>;

/** web facet 的注册入口（`web/index.js` 的 `register`，由 server 进程执行）。 */
export type PluginWebRegister = (host: PluginRegistrationHost) => void | Promise<void>;

/**
 * worker facet / extension facet 的桥。
 *
 * 插件**不碰裸 IPC** —— 这个接口就是封装层，它做三件事：
 * 1. **拼前缀**：`registerMethod('emit', h)` 自动注册为 `<我的 id>.emit`
 * 2. **解前缀**：分发时刺掉前缀，handler 收到的就是自己注册的名字
 * 3. **限制可调面**：`call` 只能命中反向表（master 侧宿主 API）；
 *    调正向方法名（`prompt` / `createSession`）会被 master 以 `unknown method` 拒掉
 *
 * 方向约定：
 * - `emit`           worker → 浏览器（SSE 的 `plugin_event`，无回执，可丢）
 * - `registerMethod` 浏览器/master → 本插件（`<id>.<name>`，有回执、有顺序）
 * - `call`           worker → master（`im.sendFile` 这类反向方法）
 * - `log`            插件日志进平台日志（自动带 pluginId）
 *
 * 要回执、要顺序 → 用 `registerMethod` / `call`；可丢、高频 → 用 `emit`。
 */
export interface PluginWorkerBridge {
  readonly pluginId: string;
  /** 发一条插件事件。不做节流；平台侧只有 64 KiB / 100 帧每秒的硬上限。 */
  emit(name: string, data: unknown): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void;
  /**
   * 注册一个本插件可被调用的方法。`name` 不带前缀（如 `'emit'`）——
   * 完整名 `<pluginId>.<name>` 由封装层拼。
   *
   * 重名或名字不合法会被拒并记 error 日志，不会静默失败。
   */
  registerMethod?(
    name: string,
    handler: (params: unknown, ctx: PluginMethodContext) => unknown | Promise<unknown>,
  ): void;
  /**
   * 调一个反向方法（master 侧宿主 API），如 `call('im.sendFile', [{ filePath }])`。
   * 只能调反向表里的方法；正向方法名会得到 `unknown method`。
   */
  call?(method: string, args?: unknown[]): Promise<unknown>;
}

/**
 * extension facet 入口的第二个参数。
 * 未启用 bridged 模式时为 `undefined`（此时拿不到 `emit`）。
 */
export interface ExtensionFacetContext {
  bridge: PluginWorkerBridge;
}

/**
 * web facet 的契约类型在 `@pi-agent-platform/plugin-types/web`（DOM 类型只在那里出现，
 * 避免 server / worker 这类非 DOM 侧的 tsconfig 被迫引入 DOM lib）。
 */

// ───────────────────────── 代码即契约（change: plugin-mechanism-v2）─────────────────────────

/**
 * 退订函数。`host` 上每个注册/订阅函数都返回它；装载器按插件 id 记账，
 * 禁用/卸载/重载时统一调用。**必须幂等**。
 */
export type Disposer = () => void;

/**
 * 会话能力面 —— 插件对"某个会话做一件事"的唯一入口。
 *
 * `call` 调的就是平台方法名（`prompt` / `abort`）或插件自己注册的正向方法名；
 * `sessionId` **永远由调用方给**，宿主不提供"选会话"语义（会话映射归插件自己维护）。
 */
export interface PluginSessionsApi {
  call<T = unknown>(sessionId: string, name: string, args?: unknown[]): Promise<T>;
  get(sessionId: string): Promise<HostSessionSummaryLike | null>;
  list(): Promise<HostSessionSummaryLike[]>;
  status(sessionId: string): Promise<string>;
  hasRow(sessionId: string): Promise<boolean>;
  /** 订阅该会话的原生事件流；返回幂等退订。 */
  subscribe(sessionId: string, listener: (event: unknown) => void, onDispose?: (reason: string) => void): Disposer;
  /**
   * 取一个**可用**会话（无人值守跑一轮的入口）。
   *
   * 不给 `sessionId` = 新建；给了就必须存在且属于该 agent（否则抛错，fail closed）。
   */
  ensure(input: { agentId: string; sessionId?: string; title?: string }): Promise<{ sessionId: string; created: boolean }>;
  /**
   * 把一条非用户消息（`<system-event>` 信封）交给会话。
   *
   * 信封文本由内核唯一构造，插件只给结构化字段；**返回即"送到"**。
   */
  systemEvent(input: {
    sessionId: string;
    kind: string;
    source?: string;
    name?: string;
    run?: string;
    instruction?: string;
    data?: unknown;
    /** agent 正忙时的处理：`followUp` 排队 / `steer` 插队 / 不传 = pi 报错。 */
    streamingBehavior?: 'steer' | 'followUp';
  }): Promise<void>;

  // ── 会话管理（`admin` 这类插件用；行为与 HTTP 路由同一份实现）──
  detail(sessionId: string): Promise<(Record<string, unknown> & { workerAlive: boolean }) | null>;
  find(filter?: {
    agentId?: string;
    title?: string;
    status?: 'active' | 'archived';
  }): Promise<Array<Record<string, unknown> & { workerAlive: boolean }>>;
  update(
    sessionId: string,
    patch: { title?: string; model?: string; thinkingLevel?: 'off' | 'low' | 'medium' | 'high'; config?: unknown },
  ): Promise<Record<string, unknown> & { workerAlive: boolean }>;
  restart(sessionId: string): Promise<{ restarted: true; workerPid: number; historyRestored: true }>;
}

/** 会话摘要（与内核 `HostSessionSummary` 同形，契约包不依赖内核所以单列一份）。 */
export interface HostSessionSummaryLike {
  id: string;
  agentId?: string;
  status: string;
  hasRow: boolean;
}

/** agent 配置能力面（只读为主；`update` 用于插件维护自己的配置块）。 */
export interface PluginAgentsApi {
  list(): Promise<Array<{ id: string; name: string; [key: string]: unknown }>>;
  get(agentId: string): Promise<Record<string, unknown> | null>;
  update(agentId: string, patch: Record<string, unknown>): Promise<void>;
}

/** 数据面：迁移登记 + 查询。读写都开放（插件完全可信）。 */
export interface PluginDbApi {
  /** 执行幂等 DDL 并登记表归属（卸载时用于提示"留下的表"）。 */
  migrate(name: string, ddl: string): void;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
}

/** 生命周期钩子。 */
export interface PluginLifecycleApi {
  onSessionCreated(hook: (sessionId: string, agentId: string) => void): Disposer;
  onSessionDisposed(hook: (sessionId: string, reason: string) => void): Disposer;
  /** 进程运行态**快照**（纯数据）。平台不给 `workerPool` 句柄 —— 要信息，不要能力。 */
  runtime(): {
    version: string;
    uptimeMs: number;
    nodeEnv: string;
    port: number;
    pid: number;
    workers: { active: number; placeholders: number; max: number; pendingCalls: number };
  };
}

/** 事件出口：仅 worker 侧可发（worker → server → SSE），无回执、可丢。 */
export interface PluginEventsApi {
  emit(name: string, data: unknown): void;
}

/**
 * 插件间**广播**（进程内）—— 发布方与订阅方互不认识。
 *
 * topic 必须先 `declare`；`declaredBy` 决定谁拥有契约：
 * - `publisher`：只有声明者能发（防冒名），任何人都能订阅（真正的广播）
 * - `subscriber`：只有声明者能收（防抢单），任何人都能发（能力地址）
 *
 * 返回值语义：`publish` 只回报送达数，`publishAndWait` 只回报处理成败 ——
 * **handler 的返回值一律被丢弃**。要业务数据请用 `host.services`。
 */
export interface PluginBusApi {
  declare(
    topic: string,
    options: { declaredBy: 'publisher' | 'subscriber' },
  ): { ok: boolean; reason?: string };
  /** 广播，不等处理。未声明 → `{ok:false, reason:'unknown-topic'}`；无订阅者是正常态。 */
  publish(topic: string, payload?: unknown): { ok: boolean; delivered: number; reason?: string };
  /** 同步广播：等处理完成，只回报成败（handler 抛错不外抛）。 */
  publishAndWait(
    topic: string,
    payload?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<{ ok: boolean; handled: number; failed: number; timedOut: number; reason?: string }>;
  /** 订阅。topic 尚未声明时返回 `state:'pending'`（不报错），声明后自动生效。 */
  subscribe(
    topic: string,
    listener: (payload: unknown) => void,
  ): { dispose: Disposer; state: 'matched' | 'pending' };
  /** 目录：全部已声明 topic。 */
  topics(): Array<{
    topic: string;
    owner: string;
    declaredBy: 'publisher' | 'subscriber';
    subscribers: number;
    pending: number;
    lastPublishAt: string | null;
  }>;
}

/**
 * R11 顶栏动作（图标按钮区）。
 *
 * 形状与页面/槽位一致：**地址 + 组件** —— 点开后在顶栏下方展开一个面板，
 * 面板内容就是 `web/<component>.js` 的 `mount(el, host)`。
 *
 * 为什么不是"又一个页面"：顶栏是**全局 chrome**，用户期望点图标就地展开，
 * 而不是跳走再回来。需要整页时用 `ui.page`（同时给导航项）。
 */
export interface HeaderActionDefinition {
  /** 同一插件内唯一。 */
  id: string;
  /** 图标标识（`AppIcon` 的名字，如 `bell`）。 */
  icon: string;
  /** 悬停提示 / 无障碍标签。 */
  title: string;
  /** 浏览器组件名，对应 `web/<component>.js`。 */
  component: string;
  /** 排序，小者靠前；缺省按注册顺序。 */
  order?: number;
  /**
   * 角标来源（可选）：浏览器定期 `GET /api/p/<pluginId><endpoint>` 取 `{ count }`。
   *
   * 为什么用端点而不是回调：角标要在**面板打开之前**就显示，而注册发生在 server 侧
   * （拿不到浏览器里的实时状态）。给一个只读端点是最小契约。
   */
  badge?: { endpoint: string };
}

/** UI 注册面（server 侧执行，浏览器侧消费）。 */
export interface PluginUiApi {
  /** R1 整页：一次注册同时产生菜单与路由。 */
  page(def: PageDefinition): Disposer;
  /** R11 顶栏动作：图标按钮 + 点开后的面板（平铺 / 移动端收起由宿主决定）。 */
  headerAction(def: HeaderActionDefinition): Disposer;
  /** R9 局部挂载点：把组件塞进平台已定义的槽位。 */
  slot(def: SlotDefinition): Disposer;
  /** R10 工具卡接管。 */
  toolCard(def: ToolCardRegistration): Disposer;
}

/** HTTP 注册面（挂在 `/api/p/<pluginId>/` 下，由唯一分发器承载）。 */
export interface PluginHttpApi {
  route(def: RouteRegistration): Disposer;
}

/** 方法调用上下文：会话 id 由分发侧给（R3 从 IPC 信封、R5 从正向表）。 */
export interface PluginMethodContext {
  sessionId: string;
}

/** 方法注册面：R3（server 侧反向方法）/ R5（worker 侧正向方法）同形。 */
export interface PluginMethodsApi {
  /**
   * `name` 不带前缀；完整名 `<pluginId>.<name>` 由宿主拼。重名直接拒。
   *
   * `params` 是调用方的**第一个参数**（约定：一个 params 对象，不玩多参），
   * `ctx.sessionId` 由分发侧填 —— 插件不需要自己维护"这次是哪个会话"。
   */
  handle(
    name: string,
    handler: (params: unknown, ctx: PluginMethodContext) => unknown | Promise<unknown>,
  ): Disposer;
}

/**
 * 插件拿到的宿主对象 —— 插件访问平台的**唯一**通道。
 *
 * 五个能力面：`sessions` / `agents` / `db` / `lifecycle` / `events`。
 * 注册面按 facet 暴露：server 侧重 `ui` / `http` / `methods`+`db.migrate`，
 * worker 侧重 `methods` + `events`。
 */
export interface PluginHost {
  readonly id: string;
  /** 插件安装目录（绝对路径）。 */
  readonly dir: string;
  readonly sessions: PluginSessionsApi;
  readonly agents: PluginAgentsApi;
  readonly db: PluginDbApi;
  readonly lifecycle: PluginLifecycleApi;
  readonly events: PluginEventsApi;
  readonly bus: PluginBusApi;
  readonly services: PluginServicesApi;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void;
}

/**
 * 插件间**定向调用** —— 恰好一个提供者、返回业务数据、错误外抛。
 *
 * 与 `bus` 的分工：`bus` 的返回值只是成败（业务数据被丢弃），`services` 才是拿数据的地方。
 * 与 `host.methods`（面 worker 的私有反向方法）互不相干：这里没有 `sessionId`。
 */
export interface PluginServicesApi {
  /** 声明服务。名字 MUST 是 `<插件 id>.<资源>.<动作>`；同名重复注册会被拒。
   *  `meta.pluginId` = 调用方插件 id（由宿主填，被调方无法伪造）。 */
  provide(
    name: string,
    handler: (payload: unknown, meta: { pluginId: string }) => unknown | Promise<unknown>,
  ): { ok: boolean; reason?: string };
  /** 定向调用：返回业务数据；无提供者/超时/提供者抛错都会抛给调用方。 */
  call(name: string, payload?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
  /** 目录：全部已提供的服务（其他插件可据此发现能力）。 */
  list(): Array<{ name: string; owner: string }>;
}

/**
 * pi 的工具暴露级别（pi 1.3.0 原生字段，平台原样透传）。
 *
 * - `direct`：直接进模型工具表（默认）
 * - `model-only` / `codemode`：只给模型，不进 UI 列表
 * - `deferred`：**不进上下文**，由 `tool_search` 搜到后按需激活（零上下文成本）
 * - `hidden`：不给模型（平台内部工具）
 */
export type PluginToolExposure = 'direct' | 'model-only' | 'codemode' | 'deferred' | 'hidden';

/**
 * 手写工具时用的工具定义形状（与 pi 的 `ToolDefinition` 对齐，只取平台担保的部分）。
 *
 * 为什么平台要重声明：插件手抄 pi 的 7 行 6 字段结构时字段太少，
 * **结构上写不进 `exposure`** —— 于是"deferred 工具零上下文成本"这个能力用不上。
 */
export interface PluginToolDefinition {
  /** 工具名（缺省由动作名派生；与其它工具重名时平台不注册、只 warn）。 */
  name?: string;
  description: string;
  /** JSON Schema（与动作 `params` 同一个对象）。 */
  parameters?: Record<string, unknown>;
  exposure?: PluginToolExposure;
  /** 分组（`tool_search` 匹配 + codemode 分节用；不参与命名）。 */
  namespace?: string | { name: string; instructions?: string };
  annotations?: Record<string, unknown>;
  /** 提示词片段。`exposure === 'deferred'` 时 MUST NOT 配（会破前缀缓存）。 */
  promptSnippet?: string;
  promptGuidelines?: string[];
}

/** 动作的 `tool` 暴露声明：工具元数据（名字可由平台派生）。 */
export interface PluginActionToolExposure extends Omit<PluginToolDefinition, 'name' | 'parameters'> {
  /** 覆盖派生出来的工具名；缺省 `<pluginId>__<action 点→下划线>`。 */
  name?: string;
}

/** 动作的 HTTP 暴露声明。MUST 是对象（布尔被拒）：暴露面要有地址。 */
export interface PluginActionHttpExposure {
  /** 子路径（相对 `/api/p/<pluginId>`，以 `/` 开头）；缺省由动作名推导。 */
  path?: string;
}

/** 动作 handler 的上下文。 */
export interface PluginActionContext {
  /** 调用方所属的会话（HTTP 面为 undefined）。跨插件调用时对目标插件通常无意义。 */
  sessionId?: string;
  /** 调用方身份（同一进程内可信，由平台填）。 */
  caller?: { pluginId: string; kind: 'worker' | 'plugin' | 'http' };
}

/**
 * 一份 handler + 五个**独立**的暴露字段。
 *
 * | 字段 | 谁会看到 | 缺省 |
 * |---|---|---|
 * | `reverse` | 自己插件的 worker（`<id>.<action>` 反向方法） | `true` |
 * | `scope` | 只约束 `reverse` 的调用来源（`own` = 只有自己） | `'own'` |
 * | `service` | 别的插件的 server facet（`host.services`） | `false` |
 * | `tool` | 模型（pi 工具） | `null` |
 * | `http` | 外部客户端（`POST /api/p/<id>/<path>`） | `null` |
 *
 * 默认值的判据：**漏了会静默坏的面默认开，漏了会明确报错的面默认关**。
 * 约束：`tool` 存在 ⇒ `reverse !== false`（工具在 worker 跑，必须经反向方法）；
 * `http` 不依赖 reverse（它直接在主进程调 handler）。
 */
export interface PluginActionDefinition {
  /** 入参 JSON Schema（工具/HTTP 面必填；反向与 service 可选）。 */
  params?: Record<string, unknown>;
  handler: (params: unknown, ctx: PluginActionContext) => unknown | Promise<unknown>;
  reverse?: boolean;
  scope?: 'own' | 'public';
  service?: boolean;
  tool?: PluginActionToolExposure | null;
  http?: PluginActionHttpExposure | null;
}

/** 动作注册面（server facet）。 */
export interface PluginActionsApi {
  /**
   * 声明一组动作。校验失败**整批不注册**并抛错（不做部分注册）。
   *
   * 一次调用产生最多四个互相独立的投影：反向方法 / service / 工具描述符 / HTTP 路由。
   */
  define(actions: Record<string, PluginActionDefinition>): void;
}

/** server 装载点的宿主（比通用宿主多四个注册面）。 */
export interface PluginServerHost extends PluginHost {
  readonly ui: PluginUiApi;
  readonly http: PluginHttpApi;
  readonly methods: PluginMethodsApi;
  /** 一份 handler → 五个暴露字段（反向 / service / tool / http）。 */
  readonly actions: PluginActionsApi;
}

/** worker 装载点的宿主。 */
export interface PluginWorkerHost extends PluginHost {
  readonly methods: PluginMethodsApi;
}

/** R1 整页声明：菜单由路由推出。 */
export interface PageDefinition {
  /** 路由路径，以 `/` 开头。 */
  path: string;
  label: string;
  icon?: string;
  /** 排序，小者靠前。 */
  order?: number;
  /** 浏览器组件名，对应 `web/<component>.js` 的 `mount`。 */
  component: string;
  /**
   * 是否进导航（默认 `true`）。
   *
   * `false` = 只登记路由、不占导航项。用于"入口在别处、但需要一个正式页面"的场景：
   * 例如顶栏铃铛（R11）点开的快速面板里给一个「查看全部」→ `/notifications`。
   * 这样既有正式页面，又不会和铃铛凑成两个同名入口。
   */
  nav?: boolean;
}

/** R9 挂载点声明：槽位名只能取平台已定义的。 */
export interface SlotDefinition {
  slot: PluginSlotName;
  /** 同槽位内唯一。 */
  id: string;
  title?: string;
  icon?: string;
  order?: number;
  component: string;
}

/** pi 原生扩展的 API 形状由 pi 提供；平台不重新声明它，避免版本漂移。 */
export type PiExtensionApi = unknown;

// ───────────────────────── 四种装载点声明 ─────────────────────────

/** ① server 装载点：`server/index.js` 的默认导出。 */
export interface PluginServerFacetDefinition {
  init(host: PluginServerHost): void | Promise<void>;
  /** 可选；平台不等待、不重试、不校验结果。 */
  dispose?(): void | Promise<void>;
}

/** ② worker 装载点：`worker/index.js` 的默认导出，每次 spawn 执行一次。 */
export interface PluginWorkerFacetDefinition {
  init(host: PluginWorkerHost): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

/** ③ pi 原生扩展装载点：`extension/index.js` 的默认导出。 */
export interface PluginExtensionFacetDefinition {
  init(pi: PiExtensionApi, host: PluginWorkerHost): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

/** ④ 浏览器装载点：组件清单（组件名 → `web/` 下的入口文件）。 */
export interface PluginWebFacetDefinition {
  /** 缺省按组件名推断 `<component>.js`。 */
  components?: Readonly<Record<string, string>>;
}

/**
 * **facet 模块**的默认导出形状 —— 纯对象，顶层零副作用。
 *
 * 一个 facet 文件 = 一个 facet 行为，所以这里没有 `apiVersion`：
 * 契约版本在 `package.json` 的 `piServer.apiVersion`（只读元数据），
 * 装载器读它就能判兼容性，**不需要执行插件代码**。
 *
 * ```ts
 * // server/index.js
 * import type { PluginDefinition } from '@pi-agent-platform/plugin-types'
 * export default {
 *   init(host) { host.ui.page({ path: '/im', label: 'IM', component: 'channels' }) },
 * } satisfies PluginDefinition
 * ```
 */
export interface PluginDefinition {
  readonly server?: PluginServerFacetDefinition;
  readonly worker?: PluginWorkerFacetDefinition;
  readonly extension?: PluginExtensionFacetDefinition;
  readonly web?: PluginWebFacetDefinition;
}

/**
 * 类型层的"定义助手"：`satisfies` 的别名，**不产生任何运行期代码**。
 *
 * 平台不提供运行时 `definePlugin()`：那会给 types-only 约束开一个口子，
 * 也会让"顶层零副作用"变成"平台帮你背锅"。
 */
export type DefinePlugin = <T extends PluginDefinition>(def: T) => T;
