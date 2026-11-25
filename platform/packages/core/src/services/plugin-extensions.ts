/**
 * 插件运行期扩展点注册表 + 装载器（change: plugin-mechanism-v2）。
 *
 * 装载点与它们的注册动作（按 facet 落位）：
 * - `server/index.js` 的 `init(host)` —— R1 页面 / R2 HTTP 路由 / R3 反向方法 / R4 表迁移
 * - `web/index.js` 的 `register(host)` —— 旧式 UI 注册入口（过渡期保留，内部转调新面）
 * - 浏览器侧 `mount(el, host)` 与本模块无关
 *
 * 四条硬规则（本模块是它们的唯一执行点）：
 * 1. **每个注册/订阅返回 disposer**，按插件 id 记账；重载/卸载时统一撤除，撤完断言归零
 * 2. **宿主能力面真正可达**：插件拿到的 `host` 是入口实现的 `HostApi`（四个能力面）
 *    —— 这是 change: plugin-mechanism-v2 修掉的"死接口"
 * 3. **无效注册一律进 `rejected`**，绝不静默丢弃
 * 4. 插件 HTTP 端点走唯一一条分发路由（Hono 路由表首次请求后冻结）
 *
 * 旧字段（`global.*` / `session.*`）作为别名保留一个版本，内部转调新面。
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type Disposer,
  type HeaderActionDefinition,
  type MenuRegistration,
  type PageDefinition,
  type PageRegistration,
  type PluginExtensions,
  type PluginHost,
  type PluginRouteHandler,
  type PluginRouteRequest,
  type PluginRouteResponse,
  type RejectedRegistration,
  type RouteRegistration,
  type SlotDefinition,
  type SurfaceRegistration,
  type ToolCardRegistration,
  type ToolCardRegion,
  type PluginActionContext,
  type PluginActionDefinition,
  type PluginSessionsApi,
} from '@pi-agent-platform/plugin-types';
import type { HostApi } from '../host-api.js';
import { PLUGIN_SLOT_NAMES, isPlatformSlotName, isPluginNamespaceSlotName } from '../plugins/constants.js';
import { childLogger } from '../logger.js';
import { validateParams } from '@pi-agent-platform/ipc-protocol';
import { getPluginSnapshot } from './plugins.js';
import type { LoadedPlugin, PluginSnapshot } from './plugins.js';

const logger = childLogger('plugin-extensions');

/** 单个 `register()` / `init()` 的执行上限。同步死循环无法被打断，属已知边界。 */
const REGISTER_TIMEOUT_MS = 5_000;
/** `dispose()` 的等待上限：平台不等、不重试、不校验结果，但不让插件挂住重载。 */
const DISPOSE_TIMEOUT_MS = 3_000;

const MENU_PARENTS = new Set(['config']);
const TOOL_MODES = new Set(['replace', 'regions']);
const TOOL_REGIONS: readonly ToolCardRegion[] = ['header', 'body', 'footer'];

/** R3 反向方法：`name` 是插件自报的短名，宿主拼前缀。 */
/** 反向方法 handler。`meta.source` = 调用方插件 id（平台填，插件无法伪造）。 */
type ReverseMethodHandler = (
  sessionId: string,
  args: unknown[],
  meta?: { source?: string },
) => Promise<unknown>;

/** 插件侧 handler 的形状（与 `PluginMethodsApi.handle` 一致）。 */
type PluginMethodHandler = (
  params: unknown,
  ctx: { sessionId: string },
) => unknown | Promise<unknown>;

/** 装载器需要的入口侧能力（内核不暴露 `WorkerPool`）。 */
export interface PluginRuntimeDeps {
  /** 入口实现的宿主能力面。 */
  host: HostApi;
  /** 动作登记表（动作契约的四类投影都落在这张表 + 既有三张表上）。 */
  actions: import('./plugin-actions.js').PluginActions;
  /** 动作 HTTP 面的全局开关（默认关闭）：关闭时动作路由一律 404。 */
  actionsHttpEnabled?: () => boolean;
  /** R3：把某插件的反向方法挂到 worker→master 分发表。 */
  registerService(
    source: `plugin:${string}`,
    kind: 'plugin',
    handlers: Record<string, ReverseMethodHandler>,
  ): void;
  /**
   * R4 台账：插件登记过一次迁移就记一笔（卸载时 CLI 用它列出"留下的表"）。
   * 存储方式由入口决定（内核不管表结构），默认不记。
   */
  recordMigration?(pluginId: string, name: string): void;
  /**
   * 插件私有**可写**目录（绝对路径）。装载前由入口创建。
   *
   * 为什么不复用 `entry.dir`：bundled 插件装在 `dist/server/plugins/`，升级即被替换 ——
   * 状态文件写在那里等于每次升级都丢。入口负责把它指到数据根下。
   */
  dataDirFor(pluginId: string): string;
}

interface PluginRuntimeEntry {
  extensions: PluginExtensions;
  /** 已注册端点（handler 不序列化，只留在这里）。 */
  routes: RouteRegistration[];
  /** 本插件注册产生的全部退订函数（**账本**）。 */
  disposers: Disposer[];
  /** facet 模块导出的可选 `dispose()`。 */
  disposeHooks: Array<() => unknown>;
  /** R3 收集的反向方法（flush 到 `registerService`）。 */
  methods: Record<string, ReverseMethodHandler>;
  /** 已打过的一次性 warn（避免每次调用刷屏）。 */
  warned: Set<string>;
}

const store = new Map<string, PluginRuntimeEntry>();
/** 全局唯一性索引（跨插件）。 */
const menuIds = new Set<string>();
const pageIds = new Set<string>();
const surfaceIds = new Set<string>();

const noopDisposer: Disposer = () => {};

/** 内核自己的命名空间（与 `__core__.` 方法名同源）：系统事件由内核发，插件自由订阅。 */
const CORE_ID = '__core__';
const TOPIC_PLUGIN_LOADED = `${CORE_ID}.plugin.loaded`;
const TOPIC_PLUGIN_UNLOADED = `${CORE_ID}.plugin.unloaded`;

/**
 * 声明内核固有 topic。
 *
 * `declaredBy: 'publisher'` → 只有内核能发（防冒名），任何插件都能订阅 —— 这正是
 * 「系统动作发生了」该有的语义。声明是幂等的（同 owner 同名覆盖），每次装载都调一遍。
 */
function declareCoreTopics(): void {
  const { host } = requireDeps();
  host.bus.declare(CORE_ID, TOPIC_PLUGIN_LOADED, { declaredBy: 'publisher' });
  host.bus.declare(CORE_ID, TOPIC_PLUGIN_UNLOADED, { declaredBy: 'publisher' });
}

/**
 * 发一条插件级事件（**一个插件一次**，不是每次注册一条）。
 *
 * payload 全部从既有账本汇总，不新增状态：插件带来了哪些 service / 页面 / 路由 / topic / 动作。
 * 消费者（例如 IM 网关）据此决定"要不要重新发现"，不需要轮询。
 */
function emitPluginLoaded(id: string, facets: Record<string, boolean | undefined>): void {
  try {
    const { host, actions } = requireDeps();
    const entry = store.get(id);
    host.bus.publish(CORE_ID, TOPIC_PLUGIN_LOADED, {
      pluginId: id,
      facets: Object.entries(facets)
        .filter(([, on]) => on === true)
        .map(([name]) => name),
      services: host.services.listOf(id).map((s) => (s.namespace ? { name: s.name, namespace: s.namespace } : { name: s.name })),
      pages: (entry?.extensions.pages ?? []).map((p) => p.path ?? p.id),
      routes: (entry?.extensions.routes ?? []).map((r) => `${r.method} ${r.path}`),
      topics: host.bus.topicsOf(id).map((topic) => topic.topic),
      actions: (actions?.listOf?.(id) ?? []).map((a) => a.name),
    });
  } catch (err) {
    logger.warn({ pluginId: id, err: String(err) }, 'plugin.loaded 事件发送失败');
  }
}

function emitPluginUnloaded(id: string): void {
  try {
    requireDeps().host.bus.publish(CORE_ID, TOPIC_PLUGIN_UNLOADED, { pluginId: id });
  } catch (err) {
    logger.warn({ pluginId: id, err: String(err) }, 'plugin.unloaded 事件发送失败');
  }
}

function emptyExtensions(): PluginExtensions {
  return { menus: [], pages: [], headerActions: [], routes: [], surfaces: [], toolCards: [], rejected: [] };
}

function entryFor(id: string): PluginRuntimeEntry {
  let entry = store.get(id);
  if (!entry) {
    entry = {
      extensions: emptyExtensions(),
      routes: [],
      disposers: [],
      disposeHooks: [],
      methods: {},
      warned: new Set(),
    };
    store.set(id, entry);
  }
  return entry;
}

/** 账本记账：注册函数拿到 disposer 后统一塞进来。 */
function track(id: string, disposer: Disposer): Disposer {
  entryFor(id).disposers.push(disposer);
  return disposer;
}

/** 运行期注册汇总（`plugin reload` 摘要、诊断页、验收断言共用一份口径）。 */
export interface ExtensionSummary {
  plugins: number;
  menus: number;
  pages: number;
  headerActions: number;
  surfaces: number;
  toolCards: number;
  routes: number;
  rejected: number;
  disposers: number;
  /** 本进程累计 import 次数（cache bust 生效的直接证据：每次 reload 必须增长）。 */
  imports: number;
}

export function extensionSummary(): ExtensionSummary {
  const total = { menus: 0, pages: 0, headerActions: 0, surfaces: 0, toolCards: 0, routes: 0, rejected: 0, disposers: 0 };
  for (const entry of store.values()) {
    total.menus += entry.extensions.menus.length;
    total.pages += entry.extensions.pages.length;
    total.headerActions += entry.extensions.headerActions.length;
    total.surfaces += entry.extensions.surfaces.length;
    total.toolCards += entry.extensions.toolCards.length;
    total.routes += entry.extensions.routes.length;
    total.rejected += entry.extensions.rejected.length;
    total.disposers += entry.disposers.length;
  }
  return { plugins: store.size, ...total, imports: importCounter };
}

/**
 * 当前注册项总数 —— 零副作用断言与"重载后回到基线"都用它。
 * 只统计**有效注册项**（`rejected` 不算：它们不占任何索引）。
 */
export function registrationCount(): number {
  let total = 0;
  for (const entry of store.values()) {
    total +=
      entry.extensions.menus.length +
      entry.extensions.pages.length +
      entry.extensions.headerActions.length +
      entry.extensions.surfaces.length +
      entry.extensions.toolCards.length +
      entry.routes.length;
  }
  return total;
}

/** 硬重置（不调插件 `dispose()`）：测试与进程退出用。 */
export function resetPluginExtensions(): void {
  store.clear();
  menuIds.clear();
  pageIds.clear();
  surfaceIds.clear();
}

function reject(id: string, kind: RejectedRegistration['kind'], entryId: string, reason: string): Disposer {
  entryFor(id).extensions.rejected.push({ kind, id: entryId, reason });
  logger.warn({ pluginId: id, kind, entryId, reason }, 'plugin registration rejected');
  return noopDisposer;
}

// ---------- 单类注册器（含校验；全部返回 disposer） ----------

function registerMenu(pluginId: string, def: MenuRegistration): Disposer {
  const entry = entryFor(pluginId).extensions;
  if (!def || typeof def.id !== 'string' || !def.id) return reject(pluginId, 'menu', '?', 'id 必须是非空字符串');
  if (typeof def.label !== 'string' || !def.label) return reject(pluginId, 'menu', def.id, 'label 必须是非空字符串');
  if (typeof def.page !== 'string' || !def.page) return reject(pluginId, 'menu', def.id, 'page 必须指向本插件的页面 id');
  if (def.parent !== undefined && !MENU_PARENTS.has(def.parent)) {
    return reject(pluginId, 'menu', def.id, `parent 只开放 ${[...MENU_PARENTS].join('/')}，收到 ${String(def.parent)}`);
  }
  if (menuIds.has(def.id)) return reject(pluginId, 'menu', def.id, '菜单 id 已被其他插件占用');
  menuIds.add(def.id);
  entry.menus.push({ ...def });
  return track(pluginId, () => {
    menuIds.delete(def.id);
    entry.menus = entry.menus.filter((m) => m.id !== def.id);
  });
}

function registerPage(pluginId: string, def: PageRegistration): Disposer {
  const entry = entryFor(pluginId).extensions;
  if (!def || typeof def.id !== 'string' || !def.id) return reject(pluginId, 'page', '?', 'id 必须是非空字符串');
  if (typeof def.entry !== 'string' || !def.entry) return reject(pluginId, 'page', def.id, 'entry 必须是文件名');
  if (pageIds.has(def.id)) return reject(pluginId, 'page', def.id, '页面 id 已被其他插件占用');
  pageIds.add(def.id);
  entry.pages.push(def);
  return track(pluginId, () => {
    pageIds.delete(def.id);
    entry.pages = entry.pages.filter((p) => p.id !== def.id);
  });
}

/**
 * R11 顶栏动作。校验与其它注册器同风格：id 唯一、图标/标题非空、组件文件真的在。
 *
 * 与页面的区别只在**位置**：页面进导航 + 独立路由，顶栏动作就地展开面板。
 */
function registerHeaderAction(pluginId: string, dir: string, def: HeaderActionDefinition): Disposer {
  const entry = entryFor(pluginId).extensions;
  if (!def || typeof def.id !== 'string' || !def.id) return reject(pluginId, 'headerAction', '?', 'id 必须是非空字符串');
  if (typeof def.icon !== 'string' || !def.icon) return reject(pluginId, 'headerAction', def.id, 'icon 必须是非空字符串');
  if (typeof def.title !== 'string' || !def.title) return reject(pluginId, 'headerAction', def.id, 'title 必须是非空字符串');
  if (typeof def.component !== 'string' || !def.component) {
    return reject(pluginId, 'headerAction', def.id, 'component 必须是 web/<name>.js 的名字');
  }
  if (entry.headerActions.some((h) => h.id === def.id)) {
    return reject(pluginId, 'headerAction', def.id, '同一插件内 headerAction id 重复');
  }
  const file = path.join(dir, 'web', `${def.component}.js`);
  if (!existsSync(file)) {
    return reject(pluginId, 'headerAction', def.id, `入口文件不存在：${path.relative(dir, file)}`);
  }
  if (def.badge && typeof def.badge.endpoint === 'string' && !def.badge.endpoint.startsWith('/')) {
    return reject(pluginId, 'headerAction', def.id, 'badge.endpoint 必须以 / 开头');
  }
  entry.headerActions.push({ ...def });
  return track(pluginId, () => {
    entry.headerActions = entry.headerActions.filter((h) => h.id !== def.id);
  });
}

function registerSurface(pluginId: string, dir: string, def: SurfaceRegistration): Disposer {
  const entry = entryFor(pluginId).extensions;
  if (!def || typeof def.id !== 'string' || !def.id) return reject(pluginId, 'surface', '?', 'id 必须是非空字符串');
  // 槽位名两空间：平台空间（闭合枚举，平台渲染 chrome）与插件空间（`<pluginId>.<name>`，
  // 由某个插件当宿主时定义语义）。插件空间只判形态，不判前缀插件是否存在。
  const platformSlot = isPlatformSlotName(def.slot);
  const pluginSlot = isPluginNamespaceSlotName(def.slot);
  if (!platformSlot && !pluginSlot) {
    return reject(
      pluginId,
      'surface',
      def.id,
      `invalid-slot-name：槽位名 ${String(def.slot)} 既不是平台空间（${PLUGIN_SLOT_NAMES.join(', ')}），也不是插件空间的 <pluginId>.<name>`,
    );
  }
  if (typeof def.entry !== 'string' || !def.entry) return reject(pluginId, 'surface', def.id, 'entry 必须是文件名');
  const key = `${def.slot}::${def.id}`;
  if (surfaceIds.has(key)) return reject(pluginId, 'surface', def.id, `槽位 ${def.slot} 内已有同名挂载点`);
  const file = path.join(dir, 'web', `${def.entry}.js`);
  if (!existsSync(file)) {
    return reject(pluginId, 'surface', def.id, `入口文件不存在：${path.relative(dir, file)}`);
  }
  surfaceIds.add(key);
  entry.surfaces.push({ ...def, scope: platformSlot ? 'session' : 'global' });
  return track(pluginId, () => {
    surfaceIds.delete(key);
    entry.surfaces = entry.surfaces.filter((s) => !(s.slot === def.slot && s.id === def.id));
  });
}

function registerToolCard(pluginId: string, dir: string, def: ToolCardRegistration): Disposer {
  const entry = entryFor(pluginId).extensions;
  if (!def || typeof def.tool !== 'string' || !def.tool) {
    return reject(pluginId, 'toolCard', '?', 'tool 必须是非空字符串');
  }
  if (def.match !== undefined && def.match !== 'exact' && def.match !== 'prefix') {
    return reject(pluginId, 'toolCard', def.tool, `match 只能是 exact/prefix，收到 ${String(def.match)}`);
  }
  if (!TOOL_MODES.has(def.mode)) return reject(pluginId, 'toolCard', def.tool, `mode 只能是 replace/regions`);
  if (entry.toolCards.some((t) => t.tool === def.tool && (t.match ?? 'exact') === (def.match ?? 'exact'))) {
    return reject(pluginId, 'toolCard', def.tool, '同一 tool 重复接管');
  }
  const declared = def.mode === 'replace' ? [def.entry] : Object.values(def.regions ?? {});
  for (const name of declared) {
    if (typeof name !== 'string' || !name) return reject(pluginId, 'toolCard', def.tool, '入口名缺失');
    const file = path.join(dir, 'web', `${name}.js`);
    if (!existsSync(file)) {
      return reject(pluginId, 'toolCard', def.tool, `入口文件不存在：${path.relative(dir, file)}`);
    }
  }
  if (def.mode === 'replace' && !def.entry) return reject(pluginId, 'toolCard', def.tool, 'mode=replace 必须给 entry');
  if (def.mode === 'regions' && (!def.regions || Object.keys(def.regions).length === 0)) {
    return reject(pluginId, 'toolCard', def.tool, 'mode=regions 必须给 regions');
  }
  if (def.regions) {
    for (const region of Object.keys(def.regions)) {
      if (!TOOL_REGIONS.includes(region as ToolCardRegion)) {
        return reject(pluginId, 'toolCard', def.tool, `未知区域 ${region}`);
      }
    }
  }
  entry.toolCards.push({ ...def });
  return track(pluginId, () => {
    entry.toolCards = entry.toolCards.filter((t) => !(t.tool === def.tool && (t.match ?? 'exact') === (def.match ?? 'exact')));
  });
}

/**
 * 校验路由模式：`/a/:id/b` 与 `/a/*` 合法；`*` 只能在最后一段。
 *
 * 段级模式而不是 glob：插件要的是"这个前缀下的都给我"（webhook / 回调），
 * 复杂匹配应该由插件自己在 handler 内做 —— 平台只负责把原始路径送到。
 */
function checkRoutePattern(pattern: string): string | undefined {
  const segments = pattern.split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === '*') {
      if (i !== segments.length - 1) return '`*` 只能作为最后一段';
      continue;
    }
    if (seg.includes('*')) return '`*` 必须独占一段（写 `/webhooks/*`，不要 `/webhooks/a*`）';
    if (seg.startsWith(':') && seg.length === 1) return '命名参数不能为空（写 `:id`）';
    if (seg.includes(':') && !seg.startsWith(':')) return '命名参数必须独占一段';
  }
  return undefined;
}

/** 两段模式是否等价（字面量相同，或同位置都是 `:` 参数）。用于拦截交叠注册。 */
function samePattern(a: string, b: string): boolean {
  const sa = a.split('/');
  const sb = b.split('/');
  if (sa.length !== sb.length) return false;
  return sa.every((seg, i) => {
    const other = sb[i]!;
    if (seg === other) return true;
    return seg.startsWith(':') && other.startsWith(':');
  });
}

/** 段匹配：返回解出的参数，不匹配返回 `null`。 */
function matchRoutePattern(pattern: string, requestPath: string): Record<string, string> | null {
  const patternSegs = pattern.split('/');
  const pathSegs = requestPath.split('/');
  const params: Record<string, string> = {};
  for (let i = 0; i < patternSegs.length; i++) {
    const seg = patternSegs[i]!;
    if (seg === '*') {
      params['*'] = pathSegs.slice(i).join('/');
      return params;
    }
    const actual = pathSegs[i];
    if (actual === undefined) return null;
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (seg !== actual) return null;
  }
  return pathSegs.length === patternSegs.length ? params : null;
}

function registerRoute(pluginId: string, def: RouteRegistration, phase: 'register' | 'init'): Disposer {
  const runtime = entryFor(pluginId);
  if (phase !== 'init') {
    return reject(pluginId, 'route', String(def?.path), '路由只能在 server facet 的 init() 里注册');
  }
  if (!def || typeof def.path !== 'string' || !def.path.startsWith('/')) {
    return reject(pluginId, 'route', String(def?.path), 'path 必须以 / 开头');
  }
  const patternError = checkRoutePattern(def.path);
  if (patternError) return reject(pluginId, 'route', def.path, patternError);
  if (def.path.startsWith('/api/p/')) return reject(pluginId, 'route', def.path, '不能注册 /api/p/ 前缀（平台已自动加上）');
  if (typeof def.handler !== 'function') return reject(pluginId, 'route', def.path, 'handler 必须是函数');
  const method = String(def.method).toUpperCase() as RouteRegistration['method'];
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return reject(pluginId, 'route', `${method} ${def.path}`, `不支持的 method ${String(def.method)}`);
  }
  if (runtime.routes.some((r) => r.method === method && r.path === def.path)) {
    return reject(pluginId, 'route', `${method} ${def.path}`, '同一 method+path 重复注册');
  }
  if (runtime.routes.some((r) => r.method === method && samePattern(r.path, def.path))) {
    return reject(pluginId, 'route', `${method} ${def.path}`, `与已有模式 ${method} ${runtime.routes.find((r) => r.method === method && samePattern(r.path, def.path))!.path} 交叠`);
  }
  runtime.routes.push({ method, path: def.path, handler: def.handler });
  runtime.extensions.routes.push({ method, path: def.path });
  return track(pluginId, () => {
    runtime.routes = runtime.routes.filter((r) => !(r.method === method && r.path === def.path));
    runtime.extensions.routes = runtime.extensions.routes.filter((r) => !(r.method === method && r.path === def.path));
  });
}

// ---------- 宿主对象 ----------

/** 一次装载的共享依赖（host + 反向方法登记口）。 */
let runtimeDeps: PluginRuntimeDeps | null = null;

function requireDeps(): PluginRuntimeDeps {
  if (!runtimeDeps) throw new Error('plugin runtime deps not set — call loadPluginExtensions(snapshot, deps) first');
  return runtimeDeps;
}

/** 记一条一次性 warn（同一 key 只打一次）。 */
function warnOnce(id: string, key: string, message: string): void {
  const entry = entryFor(id);
  if (entry.warned.has(key)) return;
  entry.warned.add(key);
  logger.warn({ pluginId: id }, message);
}

/**
 * 构造插件拿到的 `host`。
 *
 * 新面（`sessions` / `agents` / `db` / `lifecycle` / `events` / `ui` / `http` / `methods`）
 * 是真接口；旧面（`global.*` / `session.*`）保留一个版本作为别名，内部转调新面。
 */
function buildHost(plugin: LoadedPlugin, phase: 'register' | 'init'): PluginHost & {
  global: {
    menus: { register(def: MenuRegistration): Disposer };
    pages: { register(def: PageRegistration): Disposer };
    routes: { register(def: RouteRegistration): Disposer };
  };
  session: {
    surfaces: { register(def: SurfaceRegistration): Disposer };
    toolCards: { register(def: ToolCardRegistration): Disposer };
  };
  ui: {
    page(def: PageDefinition): Disposer;
    slot(def: SlotDefinition): Disposer;
    headerAction(def: HeaderActionDefinition): Disposer;
    toolCard(def: ToolCardRegistration): Disposer;
  };
  http: { route(def: RouteRegistration): Disposer };
  methods: { handle(name: string, handler: ReverseMethodHandlerWithoutSession): Disposer };
  actions: { define(defs: Record<string, PluginActionDefinition>): void };
  attachments: {
    upload(input: {
      sessionId: string;
      bytes: Uint8Array;
      mimeType: string;
      filename?: string;
    }): Promise<{
      id: string;
      sha: string;
      mimeType: string;
      sizeBytes: number;
      filename: string;
      originalFilename: string;
    }>;
    resolvePath(sessionId: string, name: string): string;
  };
  bus: {
    declare(topic: string, options: { declaredBy: 'publisher' | 'subscriber' }): { ok: boolean; reason?: string };
    publish(topic: string, payload?: unknown): { ok: boolean; delivered: number; reason?: string };
    publishAndWait(
      topic: string,
      payload?: unknown,
      options?: { timeoutMs?: number },
    ): Promise<{ ok: boolean; handled: number; failed: number; timedOut: number; reason?: string }>;
    subscribe(
      topic: string,
      listener: (payload: unknown) => void,
    ): { dispose: Disposer; state: 'matched' | 'pending' };
    topics(): unknown[];
  };
  services: {
    provide(
      name: string,
      handler: (payload: unknown) => unknown | Promise<unknown>,
      options?: { namespace?: string },
    ): { ok: boolean; reason?: string };
    call(name: string, payload?: unknown, options?: { timeoutMs?: number }): Promise<unknown>;
    list(filter?: { namespace?: string }): Array<{ name: string; owner: string; namespace?: string }>;
    namespaces(): string[];
  };
} {
  const id = plugin.entry.id;
  const dir = plugin.entry.dir;
  const { host } = requireDeps();

  const ui = {
    /** R1 整页：一次注册同时产生页面 + 菜单（菜单由路由推出）。 */
    page(def: PageDefinition): Disposer {
      if (!def || typeof def.path !== 'string' || !def.path.startsWith('/')) {
        return reject(id, 'page', String(def?.path), 'path 必须以 / 开头');
      }
      // 组件名即页面 id：`/im/channels` → 页面 id 由插件包名 + 路径派生，避免跨插件撞车。
      const pageId = `${id}${def.path}`;
      const pageDisposer = registerPage(id, {
        id: pageId,
        entry: def.component,
        path: def.path,
        ...(typeof def.parent === 'string' && def.parent ? { parent: def.parent } : {}),
      });
      if (pageDisposer === noopDisposer) return pageDisposer;
      // `nav: false` = 只登记路由，不占导航项（入口在别处，例如顶栏动作面板里的「查看全部」）
      if (def.nav === false) return pageDisposer;
      const menuDisposer = registerMenu(id, {
        id: pageId,
        label: def.label,
        icon: def.icon,
        order: def.order,
        page: pageId,
      });
      return track(id, () => {
        menuDisposer();
        pageDisposer();
      });
    },
    /** R9 局部挂载点：槽位名只能取平台已定义的。 */
    slot(def: SlotDefinition): Disposer {
      return registerSurface(id, dir, {
        id: def.id,
        slot: def.slot,
        entry: def.component,
        title: def.title ?? def.id,
        icon: def.icon,
        order: def.order,
      });
    },
    headerAction: (def: HeaderActionDefinition) => registerHeaderAction(id, dir, def),
    toolCard: (def: ToolCardRegistration) => registerToolCard(id, dir, def),
  };

  return {
    id,
    dir,
    // 插件私有可写目录：状态文件写这里（`dir` 在打包态会被升级覆盖）。
    dataDir: requireDeps().dataDirFor(id),
    // ── 能力面（真接口）──
    sessions: {
      call: (sessionId, name, args) => host.sessions.call(sessionId, name, args ?? []),
      // 会话/agent 面一律 Promise：宿主机将来可能跨进程（Electron / 远程），
      // 而内核这边是同步实现 —— 这里把同步包成 Promise，形状对外稳定。
      get: (sessionId) => Promise.resolve(host.sessions.get(sessionId)),
      list: () => Promise.resolve(host.sessions.list()),
      status: (sessionId) => Promise.resolve(host.sessions.status(sessionId)),
      hasRow: (sessionId) => Promise.resolve(host.sessions.hasRow(sessionId)),
      subscribe: (sessionId, listener, onDispose) =>
        track(id, host.sessions.subscribe(sessionId, listener, onDispose)),
      ensure: (input) => host.sessions.ensure(input),
      systemEvent: (input) => host.sessions.systemEvent(input),
      // 会话管理：与 HTTP 路由共用同一份实现（跨 worker + DB 双写，插件自己拼会漏一半）。
      // 返回的 SessionDTO 在插件契约里是宽松形状（`PluginSessionDetail`）——插件按需读字段，
      // 平台保证字段名稳定；这一处 cast 是宿主边界的唯一妥协点。
      detail: async (sessionId) =>
        host.sessions.detail(sessionId) as unknown as Awaited<ReturnType<PluginSessionsApi['detail']>>,
      find: async (filter) =>
        host.sessions.find(filter) as unknown as Awaited<ReturnType<PluginSessionsApi['find']>>,
      update: async (sessionId, patch) =>
        host.sessions.update(sessionId, patch as never) as unknown as Awaited<
          ReturnType<PluginSessionsApi['update']>
        >,
      restart: (sessionId) => host.sessions.restart(sessionId),
    },
    agents: {
      list: async () => host.agents.list().map((a) => ({ ...a })),
      get: async (agentId) => {
        const agent = host.agents.get(agentId);
        return agent ? { ...agent } : null;
      },
      update: (agentId, patch) => {
        host.agents.update(agentId, patch as never);
        return Promise.resolve();
      },
    },
    db: {
      migrate(name, ddl) {
        host.db.migrate(name, ddl);
        // 记台账（入口决定存哪）：卸载只删登记与目录，**数据保留**。
        requireDeps().recordMigration?.(id, name);
      },
      query: (sql, params) => host.db.query(sql, params),
    },
    lifecycle: {
      onSessionCreated: (hook) => track(id, host.lifecycle.onSessionCreated(hook)),
      onSessionDisposed: (hook) => track(id, host.lifecycle.onSessionDisposed(hook)),
      // 运行态快照：纯数据转发（无副作用，不需要 disposer）。
      runtime: () => host.lifecycle.runtime(),
    },
    events: {
      // `events` = 发给**浏览器**（worker → server → SSE），只有 worker 侧能发。
      // 明确告警而不是静默吞掉，否则插件作者会以为推送成功了。
      emit: (_name, _data) => warnOnce(id, 'events.emit', 'host.events.emit 只有 worker 侧可用（server 侧请用 host.bus 做插件间广播）'),
    },
    bus: {
      // `bus` = 发给**别的插件**的广播（进程内）。声明与订阅进 disposer 账本，卸载即撤销。
      declare: (topic, options) => {
        const res = host.bus.declare(id, topic, options as never);
        if (res.ok) {
          track(id, () => host.bus.disposePlugin(id));
        }
        return res;
      },
      publish: (topic, payload) => host.bus.publish(id, topic, payload),
      publishAndWait: (topic, payload, options) => host.bus.publishAndWait(id, topic, payload, options),
      subscribe: (topic, listener) => {
        const res = host.bus.subscribe(id, topic, listener);
        return { ...res, dispose: track(id, res.dispose) };
      },
      topics: () => host.bus.topics(),
    },
    services: {
      // `services` = 发给**别的插件**的定向调用（无会话上下文、返回业务数据）。
      // 短名（`task.list`）由宿主补全成 `<pluginId>.task.list` —— 与反向方法同一条约定，
      // 作者不该手写自己的 id（写错就是"前缀不符被拒"，而且 reload 时容易漂移）。
      provide: (name, handler, options) => {
        const full = name.startsWith(`${id}.`) ? name : `${id}.${name}`;
        const res = host.services.provide(id, full, handler, options);
        if (res.ok) {
          track(id, () => host.services.disposePlugin(id));
        }
        return res;
      },
      call: (name, payload, options) => host.services.call(id, name, payload, options),
      list: (filter) => host.services.list(filter),
      namespaces: () => host.services.namespaces(),
    },
    // 附件面：只给两个动作，不给 `AttachmentStore` 句柄（那会让人能绕过引用计数删文件）。
    attachments: {
      upload: (input) => host.attachments.upload(input),
      resolvePath: (sessionId, name) => host.attachments.resolvePath(sessionId, name),
    },
    // ── 注册面 ──
    ui,
    http: {
      route: (def: RouteRegistration) => registerRoute(id, def, phase),
    },
    actions: {
      /**
       * 一份 handler + 五个暴露字段 → 最多四类**投影**。
       *
       * 校验与记账在 `plugin-actions.ts`（纯函数，可单测）；这里只负责把 accepted 的
       * 记录接进已有的三张表：反向方法表（`entry.methods`，由 `flushMethods` 统一挂到
       * 分发表）、service 面、插件路由表。工具描述符没有副作用，spawn 时按会话取。
       *
       * 为什么复用而不是各开一套：`entry.methods` 已经处理了"重载时整块替换""reload 后
       * 去掉的方法不残留"，再开一张反向表就要把这些语义再实现一遍。
       */
      define(defs) {
        const res = requireDeps().actions.define(id, defs);
        if (!res.ok || !res.accepted) {
          // 整批不注册：先抛错，让 init() 失败可见（插件状态 degraded），
          // 而不是"部分动作能用、部分静默消失"。
          throw new Error(res.error ?? 'actions.define 失败');
        }
        const actionsTable = requireDeps().actions;
        for (const rec of res.accepted) {
          const run = async (params: unknown, ctx: PluginActionContext) => {
            const check = validateParams(rec.params, params);
            if (!check.ok) throw new Error(`参数校验失败 ${check.message}`);
            if (check.ignored?.length) {
              logger.debug({ pluginId: id, action: rec.action, ignored: check.ignored }, '动作 schema 含未支持的关帧（已忽略）');
            }
            return rec.handler(params, ctx);
          };

          if (rec.reverse) {
            const entry = entryFor(id);
            if (entry.methods[rec.name]) {
              throw new Error(`动作『${rec.action}』的反向方法与已注册方法重名（${rec.name}）`);
            }
            entry.methods[rec.name] = (sessionId, args, meta) =>
              Promise.resolve(
                run(args[0], {
                  sessionId,
                  caller: { pluginId: meta?.source ?? id, kind: 'worker' },
                }),
              ) as Promise<unknown>;
            track(id, () => {
              delete entry.methods[rec.name];
            });
          }

          if (rec.service) {
            const provided = host.services.provide(
              id,
              rec.name,
              (payload, meta: { pluginId: string }) => run(payload, { caller: { pluginId: meta.pluginId, kind: 'plugin' } }),
              rec.namespace ? { namespace: rec.namespace } : undefined,
            );
            if (!provided.ok) {
              throw new Error(`动作『${rec.action}』的 service 注册被拒（${provided.reason}）`);
            }
          }

          if (rec.httpPath) {
            // POST + 精确路径：动作面只承诺"一个动作一个地址"，
            // 通配/参数留给 `host.http.route`（那是作者显式声明的）。
            registerRoute(
              id,
              {
                method: 'POST',
                path: rec.httpPath,
                handler: async (request) => {
                  const enabled = requireDeps().actionsHttpEnabled?.() ?? false;
                  if (!enabled) {
                    return { status: 404, json: { error: 'action http surface is disabled' } };
                  }
                  let body: unknown = request.body;
                  if (typeof body === 'string' && body.length > 0) {
                    try {
                      body = JSON.parse(body);
                    } catch {
                      return { status: 400, json: { error: 'body 不是合法 JSON' } };
                    }
                  }
                  const check = validateParams(rec.params, body ?? {});
                  if (!check.ok) {
                    return { status: 400, json: { error: check.message } };
                  }
                  try {
                    const result = await run(body ?? {}, { caller: { pluginId: id, kind: 'http' } });
                    return { status: 200, json: result ?? null };
                  } catch (err) {
                    logger.error({ pluginId: id, action: rec.action, err: String(err) }, '动作 HTTP 执行失败');
                    return { status: 500, json: { error: err instanceof Error ? err.message : String(err) } };
                  }
                },
              },
              phase,
            );
          }

          // 兜底：动作记录在插件卸载时清空（disposePlugin 幂等）
          track(id, () => actionsTable.disposePlugin(id));
        }
      },
    },
    methods: {
      handle(name, handler) {
        if (typeof name !== 'string' || !name) return reject(id, 'method', String(name), '方法名必须是非空字符串');
        const entry = entryFor(id);
        if (entry.methods[name]) return reject(id, 'method', name, '同名方法重复注册');
        // 约定：一个 params 对象（args[0]），会话 id 走 ctx —— 与 worker 侧 bridge 同形。
        const pluginHandler = handler as PluginMethodHandler;
        entry.methods[name] = (sessionId, args) =>
          Promise.resolve(pluginHandler(args[0], { sessionId }));
        return track(id, () => {
          delete entry.methods[name];
        });
      },
    },
    // ── 旧面别名（保留一个版本）──
    global: {
      menus: { register: (def) => registerMenu(id, def) },
      pages: { register: (def) => registerPage(id, def) },
      routes: { register: (def) => registerRoute(id, def, phase) },
    },
    session: {
      surfaces: { register: (def) => registerSurface(id, dir, def) },
      toolCards: { register: (def) => registerToolCard(id, dir, def) },
    },
    log(level, message, extra) {
      logger[level]({ pluginId: id, ...extra }, message);
    },
  };
}

/** `methods.handle` 的 handler：插件只关心参数，会话 id 由分发侧传入。 */
type ReverseMethodHandlerWithoutSession = (params: unknown) => unknown | Promise<unknown>;

/**
 * 放弃某插件的全部注册项（`register()` 抛错/超时后用）。
 *
 * 为什么要回滚：半注册状态会让界面显示"贡献了半个菜单"，
 * 而目录页又会显示 registerError —— 两处互相矛盾。
 */
function rollbackPlugin(id: string): void {
  const entry = store.get(id);
  if (!entry) return;
  for (const disposer of [...entry.disposers].reverse()) {
    try {
      disposer();
    } catch (err) {
      logger.warn({ pluginId: id, err: String(err) }, 'disposer failed during rollback');
    }
  }
  entry.disposers = [];
  for (const menu of entry.extensions.menus) menuIds.delete(menu.id);
  for (const page of entry.extensions.pages) pageIds.delete(page.id);
  for (const surface of entry.extensions.surfaces) surfaceIds.delete(`${surface.slot}::${surface.id}`);
  entry.routes = [];
  entry.extensions = { ...emptyExtensions(), registerError: entry.extensions.registerError };
}

/** 校验「菜单引用的页面必须存在」。 */
function finalizeMenus(id: string): void {
  const entry = entryFor(id).extensions;
  const pages = new Set(entry.pages.map((p) => p.id));
  const kept: MenuRegistration[] = [];
  for (const menu of entry.menus) {
    if (!pages.has(menu.page)) {
      menuIds.delete(menu.id);
      entry.rejected.push({ kind: 'menu', id: menu.id, reason: `page '${menu.page}' 未注册` });
      logger.warn({ pluginId: id, menuId: menu.id, page: menu.page }, 'menu rejected: page missing');
      continue;
    }
    kept.push(menu);
  }
  entry.menus = kept;
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 导入插件模块，**破 ESM 缓存**。
 *
 * `import(sameUrl)` 会命中模块缓存 —— 这是"reload 跑的还是旧代码"的根因。
 * 用 `?v=<mtimeMs>.<counter>` 让每次 import 都是新 URL；相对 import
 * （插件内部的 `import './panel.js'`）按**入口文件所在目录**解析，不受 query 影响。
 *
 * counter 兜底：同一毫秒内连续 reload（脚本连续触发）mtime 不变，仅靠 mtime 会再次命中缓存。
 */
let importCounter = 0;

async function importEntry(file: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  const mtime = statSync(file).mtimeMs;
  const url = `${pathToFileURL(file).href}?v=${mtime}.${++importCounter}`;
  try {
    return (await import(url)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`import failed: ${String(err)}`);
  }
}

/** 本次进程内执行过的 import 次数（诊断用：`plugin reload` 摘要里能看到它在涨）。 */
export function importCount(): number {
  return importCounter;
}

// ---------- 卸载 ----------

/**
 * 卸载单个插件：`dispose()` → 跑账本 → 清除残留。
 *
 * 顺序不可换：先给插件机会自己放掉常驻资源（定时器 / 长连接），再撤平台侧注册。
 * `dispose()` 可选、尽力而为：超时或抛错只记日志，不阻塞重载。
 */
export async function disposePlugin(id: string): Promise<void> {
  const entry = store.get(id);
  if (!entry) return;

  for (const hook of entry.disposeHooks) {
    try {
      const result = await withTimeout(Promise.resolve().then(hook), DISPOSE_TIMEOUT_MS, 'dispose');
      if (result === 'timeout') logger.warn({ pluginId: id }, `dispose() 超时（>${DISPOSE_TIMEOUT_MS}ms）`);
    } catch (err) {
      logger.warn({ pluginId: id, err: String(err) }, 'dispose() failed');
    }
  }

  for (const disposer of [...entry.disposers].reverse()) {
    try {
      disposer();
    } catch (err) {
      logger.warn({ pluginId: id, err: String(err) }, 'disposer failed');
    }
  }
  entry.disposers = [];

  // 兜底：账本漏了也不留残迹（否则重载会撞"id 已被占用"）。
  for (const menu of entry.extensions.menus) menuIds.delete(menu.id);
  for (const page of entry.extensions.pages) pageIds.delete(page.id);
  for (const surface of entry.extensions.surfaces) surfaceIds.delete(`${surface.slot}::${surface.id}`);
  store.delete(id);
  emitPluginUnloaded(id);
}

/**
 * 卸载全部插件，并**断言注册表归零**。
 *
 * 断言失败说明账本有漏：记 error 后硬重置（宁可少一次泄漏告警，也不能让下次装载撞 id）。
 */
export async function disposeAllExtensions(): Promise<void> {
  for (const id of [...store.keys()]) await disposePlugin(id);
  const leftover = { plugins: store.size, menus: menuIds.size, pages: pageIds.size, surfaces: surfaceIds.size };
  if (Object.values(leftover).some((n) => n > 0)) {
    logger.error({ ...leftover }, 'plugin registry not empty after dispose — forcing reset');
    resetPluginExtensions();
  }
}

// ---------- 装载 ----------

/**
 * 装载所有 active 插件的运行期注册。
 *
 * 顺序：先卸载上一轮（`dispose()` → 账本 → 断言归零）→ 再逐个装载：
 * `register()`（web facet）→ `init()`（server facet）→ 校验菜单引用 → flush 反向方法。
 * `enabled: false` / 非 active 的插件不 import（一行代码都不执行）。
 */
export async function loadPluginExtensions(snapshot: PluginSnapshot, deps: PluginRuntimeDeps): Promise<void> {
  runtimeDeps = deps;
  await disposeAllExtensions();
  if (snapshot.disabledByFlag) {
    logger.info('plugin extensions skipped (PI_PLUGINS flag)');
    return;
  }
  declareCoreTopics();

  for (const plugin of snapshot.plugins) {
    if (plugin.status !== 'active') continue;
    const id = plugin.entry.id;

    if (plugin.facets.web) {
      const file = path.join(plugin.entry.dir, 'web', 'index.js');
      await runFacet(plugin, 'register', file, 'register');
    }

    if (plugin.facets.server) {
      const file = path.join(plugin.entry.dir, 'server', 'index.js');
      await runFacet(plugin, 'init', file, 'init');
    }

    finalizeMenus(id);
    flushMethods(plugin);
    // 插件级事件：一个插件一次（不是每次 service / page / action 注册一条）。
    emitPluginLoaded(id, plugin.facets as unknown as Record<string, boolean | undefined>);
  }

  logger.info(
    extensionSummary(),
    'plugin extensions loaded (server facets live now; worker/extension facets on next spawn)',
  );
}

/** 执行一个 facet 模块：捕获导出（含可选 dispose），超时/抛错则回滚。 */
async function runFacet(
  plugin: LoadedPlugin,
  phase: 'register' | 'init',
  file: string,
  label: 'register' | 'init',
): Promise<void> {
  const id = plugin.entry.id;
  try {
    // 顶层零副作用是**硬要求**：cache bust 会重复执行模块顶层，若那里注册了东西，
    // 每次 reload 就多一份。这里不靠静态分析，直接断言"import 没带来任何注册增量"。
    const before = registrationCount();
    const mod = await importEntry(file);
    const afterImport = registrationCount();
    if (afterImport !== before) {
      entryFor(id).extensions.registerError = `模块顶层产生了 ${afterImport - before} 个注册项（顶层必须零副作用，注册只能发生在 init()/register() 里）`;
      rollbackPlugin(id);
      logger.error({ pluginId: id, file, delta: afterImport - before }, 'top-level side effects detected — plugin rejected');
      return;
    }
    // 两种导出形状都认（迁移期）：
    // - 新契约：`export default { init(host), dispose?() }`（纯对象声明）
    // - 旧插件：`export default function init(host)` / `export function register(host)`
    const def = mod?.default as unknown;
    const facetObj = def && typeof def === 'object' ? (def as { init?: unknown; register?: unknown; dispose?: unknown }) : undefined;
    const fn =
      phase === 'init'
        ? typeof def === 'function'
          ? def
          : (facetObj?.init ?? mod?.init)
        : (mod?.register ?? facetObj?.register);
    const dispose = facetObj?.dispose ?? mod?.dispose;
    if (typeof dispose === 'function') entryFor(id).disposeHooks.push(dispose as () => unknown);
    if (typeof fn !== 'function') return;
    const result = await withTimeout(
      Promise.resolve().then(() => (fn as (host: unknown) => unknown)(buildHost(plugin, phase))),
      REGISTER_TIMEOUT_MS,
      label,
    );
    if (result === 'timeout') {
      entryFor(id).extensions.registerError = `${label}() 超时（>${REGISTER_TIMEOUT_MS}ms）`;
      rollbackPlugin(id);
      logger.warn({ pluginId: id }, `${label}() timed out`);
    }
  } catch (err) {
    entryFor(id).extensions.registerError = String(err).split('\n')[0];
    rollbackPlugin(id);
    logger.error({ pluginId: id, err: String(err) }, `${label}() failed`);
  }
}

/**
 * R3：把本插件收集到的反向方法一次性挂到分发表。
 *
 * 插件只写短名（`echo`），**前缀由宿主拼**：`<pluginId>.echo`（去掉了老 IPC 层的
 * `plugin.` 段 —— 它让同一个动作在 service 与 reverse 上是两个字符串）。
 * 注册表按前缀做准入，所以这里必须拼完整名，否则会被整批判为不合法。
 */
function flushMethods(plugin: LoadedPlugin): void {
  const id = plugin.entry.id;
  const entry = store.get(id);
  if (!entry || Object.keys(entry.methods).length === 0) return;
  const prefixed: Record<string, ReverseMethodHandler> = {};
  for (const [name, handler] of Object.entries(entry.methods)) {
    prefixed[name.startsWith(`${id}.`) ? name : `${id}.${name}`] = handler;
  }
  try {
    requireDeps().registerService(`plugin:${id}`, 'plugin', prefixed);
  } catch (err) {
    logger.error({ pluginId: id, err: String(err) }, 'registerService failed');
  }
}

// ---------- 查询 ----------

/** 单插件的全部注册项（含被拒项）。未装载的插件返回空集合。 */
export function getPluginExtensions(id: string): PluginExtensions {
  const entry = store.get(id);
  if (!entry) return emptyExtensions();
  return {
    ...entry.extensions,
    menus: [...entry.extensions.menus],
    pages: [...entry.extensions.pages],
    headerActions: [...entry.extensions.headerActions],
    surfaces: [...entry.extensions.surfaces],
    toolCards: [...entry.extensions.toolCards],
    rejected: [...entry.extensions.rejected],
  };
}

export interface GlobalExtensionItem<T> {
  pluginId: string;
  def: T;
}

/** 全局注册（菜单 / 页面）——导航与插件页路由用。 */
export function listGlobalExtensions(): {
  menus: GlobalExtensionItem<MenuRegistration>[];
  pages: GlobalExtensionItem<PageRegistration>[];
  headerActions: GlobalExtensionItem<HeaderActionDefinition>[];
  /** 插件空间槽位（`<pluginId>.<name>`）：宿主插件自己装载，与页面同级全局可见。 */
  surfaces: GlobalExtensionItem<SurfaceRegistration>[];
} {
  const menus: GlobalExtensionItem<MenuRegistration>[] = [];
  const pages: GlobalExtensionItem<PageRegistration>[] = [];
  const headerActions: GlobalExtensionItem<HeaderActionDefinition>[] = [];
  const surfaces: GlobalExtensionItem<SurfaceRegistration>[] = [];
  for (const [pluginId, entry] of store) {
    for (const def of entry.extensions.menus) menus.push({ pluginId, def });
    for (const def of entry.extensions.pages) pages.push({ pluginId, def });
    for (const def of entry.extensions.headerActions) headerActions.push({ pluginId, def });
    for (const def of entry.extensions.surfaces) {
      if ((def as SurfaceRegistration & { scope?: string }).scope === 'global') surfaces.push({ pluginId, def });
    }
  }
  surfaces.sort(
    (a, b) =>
      (a.def.order ?? Number.MAX_SAFE_INTEGER) - (b.def.order ?? Number.MAX_SAFE_INTEGER) ||
      a.pluginId.localeCompare(b.pluginId) ||
      a.def.id.localeCompare(b.def.id),
  );
  headerActions.sort(
    (a, b) =>
      (a.def.order ?? Number.MAX_SAFE_INTEGER) - (b.def.order ?? Number.MAX_SAFE_INTEGER) ||
      a.pluginId.localeCompare(b.pluginId),
  );
  // 排序：显式 order 优先，其次 pluginId+id（稳定输出）
  menus.sort((a, b) => (a.def.order ?? Number.MAX_SAFE_INTEGER) - (b.def.order ?? Number.MAX_SAFE_INTEGER) || a.def.id.localeCompare(b.def.id));
  return { menus, pages, headerActions, surfaces };
}

/**
 * 页面 + 导航元信息（**合一**）。
 *
 * `ui.page({ path, label, icon, component })` 一次注册产生页面与菜单两条注册项，
 * 但消费方（导航 / 路由）不该再去 join 两遍：这里把菜单上的展示字段摊到页面上，
 * 合成一份"可点击的页面"。旧式 `pages` + `menus` 分开注册的插件也照样能合出来。
 */
export interface GlobalPageItem extends PageRegistration {
  pluginId: string;
  /** 导航展示字段（来自引用该页面的菜单；没有菜单就是 `undefined` = 不进导航）。 */
  path?: string;
  label?: string;
  icon?: string;
  order?: number;
  /** 父页面路径（`/im`）或静态父模块名（`config`）。 */
  parent?: string;
}

export function listGlobalPageItems(): GlobalPageItem[] {
  const out: GlobalPageItem[] = [];
  for (const [pluginId, entry] of store) {
    const byPage = new Map(entry.extensions.menus.map((m) => [m.page, m]));
    for (const page of entry.extensions.pages) {
      const menu = byPage.get(page.id);
      // `ui.page` 把路径写进了页面 id（`<pluginId>/<path>`）；旧式插件没有路径字段，
      // 就退回旧的 `/plugin-page/<id>/<pageId>` 形态（由前端拼）。
      out.push({
        ...page,
        pluginId,
        ...(menu
          ? {
              label: menu.label,
              icon: menu.icon,
              order: menu.order,
              // 页面上声明的 `parent` 是跨插件挂载（`/im`）；菜单上的 `parent` 是旧的静态父模块。
              parent: menu.parent ?? page.parent,
            }
          : {}),
      });
    }
  }
  out.sort(
    (a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
      a.pluginId.localeCompare(b.pluginId) ||
      a.id.localeCompare(b.id),
  );
  return out;
}

/** 会话级注册（槽位 / 工具卡片），只保留 `enabledIds` 里的插件。 */
export function listSessionExtensions(enabledIds: ReadonlySet<string>): {
  surfaces: GlobalExtensionItem<SurfaceRegistration>[];
  toolCards: GlobalExtensionItem<ToolCardRegistration>[];
} {
  const surfaces: GlobalExtensionItem<SurfaceRegistration>[] = [];
  const toolCards: GlobalExtensionItem<ToolCardRegistration>[] = [];
  for (const [pluginId, entry] of store) {
    if (!enabledIds.has(pluginId)) continue;
    for (const def of entry.extensions.surfaces) surfaces.push({ pluginId, def });
    for (const def of entry.extensions.toolCards) toolCards.push({ pluginId, def });
  }
  surfaces.sort((a, b) => (a.def.order ?? Number.MAX_SAFE_INTEGER) - (b.def.order ?? Number.MAX_SAFE_INTEGER));
  return { surfaces, toolCards };
}

// ---------- 分发 ----------

export interface DispatchContext {
  /** 已剥掉 `/api/p/<pluginId>` 前缀的路径。 */
  path: string;
  method: string;
  query: Record<string, string>;
  body: string;
  headers: Headers;
}

/** 已登记的插件 id（含未启用的：用于把「没启用」与「没这条路由」区分开）。 */
export function listPluginIds(pluginsDir: string): string[] {
  return getPluginSnapshot(pluginsDir).plugins.map((p) => p.entry.id);
}

/** 该插件是否注册过任何端点（用于「未匹配」时的差异化提示）。 */
export function hasRoutes(id: string): boolean {
  return (store.get(id)?.routes.length ?? 0) > 0;
}

/**
 * 执行一次插件端点调用；未匹配返回 `null`。
 *
 * 返回标准 `Response` 时调用方 MUST 原样透传（流式响应 / 自定义状态码）。
 */
export async function dispatchPluginRoute(
  id: string,
  ctx: DispatchContext,
  isEnabled: (pluginId: string) => boolean,
): Promise<PluginRouteResponse | Response | 'not-enabled' | 'not-found' | null> {
  if (!isEnabled(id)) return 'not-enabled';
  const routes = store.get(id)?.routes;
  if (!routes || routes.length === 0) return null;
  const method = ctx.method.toUpperCase();
  // 两遍匹配：**字面量永远优先**，再看模式路由（按注册顺序）。
  // 一遍扫会变成"注册顺序决定语义"，插件在 `:id` 之后再注册 `/item/literal`
  // 就拿不到自己的路由 —— 那是隐式规则，作者不可能猜对。
  let matched: { route: RouteRegistration; params: Record<string, string> } | null = null;
  const exact = routes.find((r) => r.method === method && r.path === ctx.path);
  if (exact) {
    matched = { route: exact, params: {} };
  } else {
    for (const r of routes) {
      if (r.method !== method) continue;
      if (!r.path.includes(':') && !r.path.includes('*')) continue;
      const params = matchRoutePattern(r.path, ctx.path);
      if (params) {
        matched = { route: r, params };
        break;
      }
    }
  }
  if (!matched) return null;
  const request: PluginRouteRequest = {
    method,
    // 原始路径原样给（剥前缀后不归一化）：webhook 自己分发。
    path: ctx.path,
    params: matched.params,
    query: ctx.query,
    body: ctx.body,
    header: (name) => ctx.headers.get(name) ?? undefined,
  };
  const handler = matched.route.handler as PluginRouteHandler;
  const result = await handler(request);
  return result ?? {};
}
