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
 * 当前平台契约版本。插件在 `package.json` 的 `piServer.apiVersion` 声明。
 *
 * 为何 `bridge.onEmit` 移除却**没有**升到 '2'（change: ipc-protocol-unify 的落地结论）：
 * 1. 变动只涉及一个**可选**成员（`onEmit` 本来就是 `?`），`emit` / `log` 未变；
 * 2. 全仓仅内置的 kitchen-sink 示例用到它，已同期改为 `registerMethod`；
 * 3. 版本号是硬门禁（`apiVersion !== PLUGIN_API_VERSION` 直接拒装），升号会把
 *    已有的 demo 插件（声明 "1"）全部判为不兼容，代价远大于收益。
 * 下次要改 `emit` / `log` / facet 目录约定这类**必选面**时，再升。
 */
export const PLUGIN_API_VERSION = '1' as const;

export type PluginApiVersion = typeof PLUGIN_API_VERSION;

/** facet 名 = 目录名。目录存在即声明该 facet。 */
export type PluginFacetName = 'server' | 'worker' | 'extension' | 'web';

export const PLUGIN_FACET_NAMES: readonly PluginFacetName[] = ['server', 'worker', 'extension', 'web'];

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

export const PLUGIN_SLOT_NAMES: readonly PluginSlotName[] = ['chat.rail.right'];

/**
 * facet 在当前平台的装载支持度。
 *
 * - `loaded`        平台会真的执行它（`server`/`worker`/`extension`/`web` 都有装载实现）
 * - `declared-only` 只有契约与目录探测，**没有装载实现**
 *
 * 这个映射是目录页"扩展点是否可用"的唯一依据：不允许用"目录存在"冒充"可用"。
 */
export type FacetSupport = 'loaded' | 'declared-only';

export const FACET_SUPPORT: Readonly<Record<PluginFacetName, FacetSupport>> = {
  server: 'loaded',
  worker: 'loaded',
  extension: 'loaded',
  web: 'loaded',
};

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

/** `registry.json` 的单个条目（安装事实）。 */
export interface PluginRegistryEntry {
  id: string;
  version: string;
  /** 安装目录绝对路径。 */
  dir: string;
  /** 默认启用；`false` 时任何 facet 都不加载。 */
  enabled: boolean;
  /** facet 级开关，缺省视为 true。 */
  facets?: Partial<Record<PluginFacetName, boolean>>;
  /** 安装时间（ISO 字符串），仅用于排序展示。 */
  installedAt?: string;
}

/** `registry.json` 根结构。 */
export interface PluginRegistryFile {
  version: 1;
  plugins: PluginRegistryEntry[];
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
}

/** 插件 HTTP 端点的请求视图（`path` 已剥掉 `/api/p/<pluginId>` 前缀）。 */
export interface PluginRouteRequest {
  method: string;
  path: string;
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
  /** 以 `/` 开头；不支持通配符（分发器按精确路径匹配）。 */
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
  kind: 'menu' | 'page' | 'route' | 'surface' | 'toolCard' | 'triggerSource';
  /** 被拒项的自报标识（可能重复，故意的）。 */
  id: string;
  reason: string;
}

/** 单个插件的运行期注册结果。 */
export interface PluginExtensions {
  menus: MenuRegistration[];
  pages: PageRegistration[];
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
/**
 * `host.triggerSources.register` 的描述符（change: trigger-scheduling）。
 * 结构与 server 侧 `SourceSpec` 同契约：只描述「配置校验 + 时间计算」，
 * 不含 HTTP 路由（Hono 路由表首次请求后冻结）。
 */
export interface TriggerSourceRegistration {
  /** 持久化进 `triggers.source` 的名字（重名注册会被拒绝）。 */
  source: string;
  label?: string;
  description?: string;
  /** 校验并归一化 config；抛错即视为无效（message 会直接展示）。 */
  validateConfig(config: Record<string, unknown>): Record<string, unknown>;
  /** 下一次触发时刻（epoch ms，严格大于 from）；null = 不再触发。 */
  computeNextAt?(config: Record<string, unknown>, from: number): number | null;
  /** 每日一次的清理钩子。 */
  housekeeping?(ctx: { deleteStaleDisabled(source: string, before: number): number }): void;
  defaultMaxRuns?: number;
  httpEntry?: boolean;
  hasSecret?: boolean;
}

/** `host.triggers` —— 进程内触发（不过 HTTP，不需要 secret）。 */
export interface PluginTriggersHost {
  /** 立即触发一次；走与定时/webhook 完全相同的 dispatch 路径。 */
  fire(triggerId: string, payload?: unknown): Promise<{ status: string; runId?: string; sessionId?: string; error?: string }>;
  /** 列出触发器（默认只含启用中的）。 */
  list(filter?: { agentId?: string; source?: string; includeDisabled?: boolean }): unknown[];
}

export interface PluginRegistrationHost {
  readonly id: string;
  /** 插件安装目录（绝对路径），便于插件自己读写文件。 */
  readonly dir: string;
  readonly global: {
    menus: { register(def: MenuRegistration): void };
    pages: { register(def: PageRegistration): void };
    routes: { register(def: RouteRegistration): void };
  };
  /** 触发器扩展点（change: trigger-scheduling）。 */
  readonly triggers: PluginTriggersHost;
  /** 注册新的触发器来源（与内置 cron/once/webhook 同一张注册表）。 */
  readonly triggerSources: { register(def: TriggerSourceRegistration): void };
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
 * 1. **拼前缀**：`registerMethod('emit', h)` 自动注册为 `plugin.<我的 id>.emit`
 * 2. **解前缀**：分发时刺掉前缀，handler 收到的就是自己注册的名字
 * 3. **限制可调面**：`call` 只能命中反向表（master 侧宿主 API）；
 *    调正向方法名（`prompt` / `createSession`）会被 master 以 `unknown method` 拒掉
 *
 * 方向约定：
 * - `emit`           worker → 浏览器（SSE 的 `plugin_event`，无回执，可丢）
 * - `registerMethod` 浏览器/master → 本插件（`plugin.<id>.<name>`，有回执、有顺序）
 * - `call`           worker → master（`plugin.im.sendFile` 这类反向方法）
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
   * 完整名 `plugin.<pluginId>.<name>` 由封装层拼。
   *
   * 重名或名字不合法会被拒并记 error 日志，不会静默失败。
   */
  registerMethod?(name: string, handler: (params: unknown) => unknown | Promise<unknown>): void;
  /**
   * 调一个反向方法（master 侧宿主 API），如 `call('plugin.im.sendFile', [{ filePath }])`。
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
