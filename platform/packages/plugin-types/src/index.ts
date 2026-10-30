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

/** 当前平台契约版本。插件在 `package.json` 的 `piServer.apiVersion` 声明。 */
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
export type PluginSlotName = 'chat.rail-icon' | 'chat.drawer';

export const PLUGIN_SLOT_NAMES: readonly PluginSlotName[] = ['chat.rail-icon', 'chat.drawer'];

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
  /**
   * web 槽位声明（v1 静态声明）。
   * 运行期 `host.surfaces.register()` 属于 server facet 能力，本 change 不做。
   */
  web?: { surfaces?: SurfaceDeclaration[] };
}

/** `package.json` 里声明的槽位（`id` / `slot` / `mountKey` 必填）。 */
export interface SurfaceDeclaration {
  id: string;
  slot: PluginSlotName;
  mountKey: string;
  title: string;
  icon?: string;
  order?: number;
}

/** 从 `package.json` 解析出的插件清单。 */
export interface PluginManifest {
  /** 插件 id = npm 包名。 */
  name: string;
  version: string;
  apiVersion: string;
  requiresPlugins: Record<string, string>;
  /** 静态声明的 web 槽位（可能为空）。 */
  surfaces: SurfaceDeclaration[];
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

/** 插件向宿主注册的 UI 槽位。 */
export interface SurfaceRegistration {
  /** 槽位标识，全局唯一；重复注册后者被拒绝。 */
  id: string;
  slot: PluginSlotName;
  /** 浏览器入口文件名（不含 `.js`），对应 `web/<mountKey>.js`。 */
  mountKey: string;
  title: string;
  /** 图标标识，由宿主解析；缺省时宿主用默认图标。 */
  icon?: string;
  /** 同一槽位内的排序，小者靠前。 */
  order?: number;
}

/** server facet 入口签名（骨架，能力按需扩展）。 */
export interface PluginServerHost {
  /** 插件 id，便于日志区分。 */
  readonly id: string;
  /** 注册 UI 槽位。 */
  surfaces: {
    register(def: SurfaceRegistration): void;
  };
  /** 写日志（自动带 pluginId）。 */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void;
}

/**
 * worker facet / extension facet 的上行桥（骨架）。
 *
 * 插件上行桥。
 *
 * 方向约定（与 chord 无关，刻意保持窄接口）：
 * - `emit`   worker → 浏览器（经 server SSE 的 `plugin` 事件）
 * - `onEmit` 浏览器 → worker（经 `POST /api/sessions/:id/plugins/:pluginId/emit`）
 * - `log`    插件日志进平台日志（自动带 pluginId）
 */
export interface PluginWorkerBridge {
  readonly pluginId: string;
  /** 发一条插件事件。不做节流；平台侧只有 64 KiB / 100 帧每秒的硬上限。 */
  emit(name: string, data: unknown): void;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void;
  /** 接收浏览器侧 `emit`。同一插件只保留最后一个处理器。 */
  onEmit?(handler: (name: string, data: unknown) => void | Promise<void>): void;
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
