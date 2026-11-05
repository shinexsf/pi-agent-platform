/**
 * 插件运行期扩展点注册表（change: plugin-runtime-extensions）。
 *
 * 三个入口里有两个在这里执行：
 * - `web/index.js` 的 `register(host)` —— 声明菜单 / 页面 / rail 槽位 / 工具卡片
 * - `server/index.js` 的 `init(host)` —— 声明 HTTP 端点
 * 第三个 `mount(el, host)` 在浏览器里，与本模块无关。
 *
 * 设计要点（详见 doc/architecture/current/pi-agent-server_plugins-runtime.md）：
 * - 注册表在 server 内存里，是唯一真相；浏览器只消费查询结果
 * - 作用域写在 API 形状里（`global.*` / `session.*`），不靠可选字段推断
 * - 无效注册一律进 `rejected`，绝不静默丢弃
 * - 插件 HTTP 端点走唯一一条分发路由（Hono 路由表首次请求后冻结）
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PLUGIN_SLOT_NAMES,
  type MenuRegistration,
  type PageRegistration,
  type PluginExtensions,
  type PluginRegistrationHost,
  type PluginRouteHandler,
  type PluginRouteRequest,
  type PluginRouteResponse,
  type RejectedRegistration,
  type RouteRegistration,
  type SurfaceRegistration,
  type ToolCardRegistration,
  type ToolCardRegion,
} from '@pi-agent-platform/plugin-types';
import { childLogger } from '../logger.js';
import { getPluginSnapshot } from './plugins.js';
import type { LoadedPlugin, PluginSnapshot } from './plugins.js';

const logger = childLogger('plugin-extensions');

/** 单个 `register()` / `init()` 的执行上限。同步死循环无法被打断，属已知边界。 */
const REGISTER_TIMEOUT_MS = 5_000;

const MENU_PARENTS = new Set(['config']);
const TOOL_MODES = new Set(['replace', 'regions']);
const TOOL_REGIONS: readonly ToolCardRegion[] = ['header', 'body', 'footer'];

interface PluginRuntimeEntry {
  extensions: PluginExtensions;
  /** 已注册端点（handler 不序列化，只留在这里）。 */
  routes: RouteRegistration[];
}

const store = new Map<string, PluginRuntimeEntry>();
/** 全局唯一性索引（跨插件）。 */
const menuIds = new Set<string>();
const pageIds = new Set<string>();
const surfaceIds = new Set<string>();

function emptyExtensions(): PluginExtensions {
  return { menus: [], pages: [], routes: [], surfaces: [], toolCards: [], rejected: [] };
}

function entryFor(id: string): PluginRuntimeEntry {
  let entry = store.get(id);
  if (!entry) {
    entry = { extensions: emptyExtensions(), routes: [] };
    store.set(id, entry);
  }
  return entry;
}

/** 清空全部注册（启动/重载时调用）。 */
export function resetPluginExtensions(): void {
  store.clear();
  menuIds.clear();
  pageIds.clear();
  surfaceIds.clear();
}

function reject(id: string, kind: RejectedRegistration['kind'], entryId: string, reason: string): void {
  entryFor(id).extensions.rejected.push({ kind, id: entryId, reason });
  logger.warn({ pluginId: id, kind, entryId, reason }, 'plugin registration rejected');
}

// ---------- 单类注册器（含校验） ----------

function registerMenu(pluginId: string, def: MenuRegistration): void {
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
}

function registerPage(pluginId: string, def: PageRegistration): void {
  const entry = entryFor(pluginId).extensions;
  if (!def || typeof def.id !== 'string' || !def.id) return reject(pluginId, 'page', '?', 'id 必须是非空字符串');
  if (typeof def.entry !== 'string' || !def.entry) return reject(pluginId, 'page', def.id, 'entry 必须是文件名');
  if (pageIds.has(def.id)) return reject(pluginId, 'page', def.id, '页面 id 已被其他插件占用');
  pageIds.add(def.id);
  entry.pages.push(def);
}

function registerSurface(pluginId: string, dir: string, def: SurfaceRegistration): void {
  const entry = entryFor(pluginId).extensions;
  if (!def || typeof def.id !== 'string' || !def.id) return reject(pluginId, 'surface', '?', 'id 必须是非空字符串');
  if (typeof def.slot !== 'string' || !PLUGIN_SLOT_NAMES.includes(def.slot)) {
    return reject(
      pluginId,
      'surface',
      def.id,
      `未知槽位 ${String(def.slot)}，可用：${PLUGIN_SLOT_NAMES.join(', ')}`,
    );
  }
  if (typeof def.entry !== 'string' || !def.entry) return reject(pluginId, 'surface', def.id, 'entry 必须是文件名');
  if (typeof def.title !== 'string' || !def.title) return reject(pluginId, 'surface', def.id, 'title 必须是非空字符串');
  const script = path.join(dir, 'web', `${def.entry}.js`);
  if (!existsSync(script)) return reject(pluginId, 'surface', def.id, `入口文件不存在：web/${def.entry}.js`);
  const key = `${def.slot}::${def.id}`;
  if (surfaceIds.has(key)) return reject(pluginId, 'surface', def.id, `槽位 ${def.slot} 内 id 已被占用`);
  surfaceIds.add(key);
  entry.surfaces.push(def);
}

function registerToolCard(pluginId: string, dir: string, def: ToolCardRegistration): void {
  const entry = entryFor(pluginId).extensions;
  if (!def || typeof def.tool !== 'string' || !def.tool) return reject(pluginId, 'toolCard', '?', 'tool 必须是非空字符串');
  const label = `${def.tool}${def.match === 'prefix' ? '*' : ''}`;
  if (def.match !== undefined && def.match !== 'exact' && def.match !== 'prefix') {
    return reject(pluginId, 'toolCard', label, `match 只能是 exact/prefix，收到 ${String(def.match)}`);
  }
  if (!TOOL_MODES.has(def.mode)) {
    return reject(pluginId, 'toolCard', label, `mode 只能是 replace/regions，收到 ${String(def.mode)}`);
  }
  if (def.mode === 'replace') {
    if (typeof def.entry !== 'string' || !def.entry) return reject(pluginId, 'toolCard', label, 'replaces 模式必须给 entry');
    if (def.regions) return reject(pluginId, 'toolCard', label, 'replace 模式不能同时声明 regions');
    if (!existsSync(path.join(dir, 'web', `${def.entry}.js`))) {
      return reject(pluginId, 'toolCard', label, `入口文件不存在：web/${def.entry}.js`);
    }
  } else {
    if (!def.regions || typeof def.regions !== 'object') return reject(pluginId, 'toolCard', label, 'regions 模式必须声明 regions');
    const keys = Object.keys(def.regions);
    if (keys.length === 0) return reject(pluginId, 'toolCard', label, 'regions 不能为空');
    for (const key of keys) {
      if (!TOOL_REGIONS.includes(key as ToolCardRegion)) {
        return reject(pluginId, 'toolCard', label, `未知区域 ${key}，可用：${TOOL_REGIONS.join(', ')}`);
      }
      const file = (def.regions as Record<string, string>)[key];
      if (typeof file !== 'string' || !file) return reject(pluginId, 'toolCard', label, `区域 ${key} 的入口名无效`);
      if (!existsSync(path.join(dir, 'web', `${file}.js`))) {
        return reject(pluginId, 'toolCard', label, `区域 ${key} 的入口文件不存在：web/${file}.js`);
      }
    }
  }
  // 同一工具同一区域只能有一个接管者；整卡替换与区域替换也互斥。
  const newRegions = def.regions ?? {};
  const conflicts = entry.toolCards.filter((existing) => {
    if (existing.tool !== def.tool) return false;
    if (existing.mode !== def.mode) return true;
    if (def.mode === 'replace') return true;
    const existingRegions = existing.regions ?? {};
    return Object.keys(newRegions).some((region) => region in existingRegions);
  });
  const conflict = conflicts[0];
  if (conflict) {
    return reject(pluginId, 'toolCard', label, `与已注册的 ${conflict.tool} 卡片冲突`);
  }
  entry.toolCards.push({ ...def, match: def.match ?? 'exact' });
}

function registerRoute(pluginId: string, def: RouteRegistration, phase: 'register' | 'init'): void {
  const runtime = store.get(pluginId) ?? entryFor(pluginId);
  if (phase === 'register') return reject(pluginId, 'route', `${def.method} ${def.path}`, '路由只能在 init(host) 里注册');
  if (!def || typeof def.path !== 'string' || !def.path.startsWith('/')) {
    return reject(pluginId, 'route', String(def?.path), 'path 必须以 / 开头');
  }
  if (def.path.includes('*')) return reject(pluginId, 'route', def.path, '分发器按精确路径匹配，不支持通配符');
  if (def.path.startsWith('/api/p/')) return reject(pluginId, 'route', def.path, '不能注册 /api/p/ 前缀（平台已自动加上）');
  if (typeof def.handler !== 'function') return reject(pluginId, 'route', def.path, 'handler 必须是函数');
  const method = String(def.method).toUpperCase() as RouteRegistration['method'];
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return reject(pluginId, 'route', `${method} ${def.path}`, `不支持的 method ${String(def.method)}`);
  }
  if (runtime.routes.some((r) => r.method === method && r.path === def.path)) {
    return reject(pluginId, 'route', `${method} ${def.path}`, '同一 method+path 重复注册');
  }
  runtime.routes.push({ method, path: def.path, handler: def.handler });
  runtime.extensions.routes.push({ method, path: def.path });
}

// ---------- 宿主对象 ----------

function buildHost(plugin: LoadedPlugin, phase: 'register' | 'init'): PluginRegistrationHost {
  const id = plugin.entry.id;
  const dir = plugin.entry.dir;
  return {
    id,
    dir,
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

/**
 * 放弃某插件的全部注册项（`register()` 抛错/超时后用）。
 *
 * 为什么要回滚：半注册状态会让界面显示"贡献了半个菜单"，
 * 而目录页又会显示 registerError —— 两处互相矛盾。
 */
function rollbackPlugin(id: string): void {
  const entry = store.get(id);
  if (!entry) return;
  for (const menu of entry.extensions.menus) menuIds.delete(menu.id);
  for (const page of entry.extensions.pages) pageIds.delete(page.id);
  for (const surface of entry.extensions.surfaces) surfaceIds.delete(`${surface.slot}::${surface.id}`);
  entry.extensions = { ...emptyExtensions(), registerError: entry.extensions.registerError };
  entry.routes = [];
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

async function importEntry(file: string): Promise<Record<string, unknown> | null> {
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  try {
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`import failed: ${String(err)}`);
  }
}

// ---------- 装载 ----------

/**
 * 装载所有 active 插件的运行期注册。
 *
 * 顺序：先 `register()`（web facet）→ 再 `init()`（server facet）→ 最后校验菜单引用。
 * `enabled: false` / 非 active 的插件不 import（一行代码都不执行）。
 */
export async function loadPluginExtensions(snapshot: PluginSnapshot): Promise<void> {
  resetPluginExtensions();
  if (snapshot.disabledByFlag) {
    logger.info('plugin extensions skipped (PI_PLUGINS flag)');
    return;
  }

  for (const plugin of snapshot.plugins) {
    if (plugin.status !== 'active') continue;
    const id = plugin.entry.id;

    if (plugin.facets.web) {
      const file = path.join(plugin.entry.dir, 'web', 'index.js');
      try {
        const mod = await importEntry(file);
        const register = mod?.register;
        if (typeof register === 'function') {
          const result = await withTimeout(
            Promise.resolve().then(() => (register as (host: PluginRegistrationHost) => unknown)(buildHost(plugin, 'register'))),
            REGISTER_TIMEOUT_MS,
            'register',
          );
          if (result === 'timeout') {
            entryFor(id).extensions.registerError = `register() 超时（>${REGISTER_TIMEOUT_MS}ms）`;
            rollbackPlugin(id);
            logger.warn({ pluginId: id }, 'register() timed out');
          }
        }
      } catch (err) {
        entryFor(id).extensions.registerError = String(err).split('\n')[0];
        rollbackPlugin(id);
        logger.error({ pluginId: id, err: String(err) }, 'register() failed');
      }
    }

    if (plugin.facets.server) {
      const file = path.join(plugin.entry.dir, 'server', 'index.js');
      try {
        const mod = await importEntry(file);
        const init = mod?.default ?? mod?.init;
        if (typeof init === 'function') {
          const result = await withTimeout(
            Promise.resolve().then(() => (init as (host: PluginRegistrationHost) => unknown)(buildHost(plugin, 'init'))),
            REGISTER_TIMEOUT_MS,
            'init',
          );
          if (result === 'timeout') {
            entryFor(id).extensions.registerError = `init() 超时（>${REGISTER_TIMEOUT_MS}ms）`;
            rollbackPlugin(id);
            logger.warn({ pluginId: id }, 'init() timed out');
          }
        }
      } catch (err) {
        entryFor(id).extensions.registerError = String(err).split('\n')[0];
        rollbackPlugin(id);
        logger.error({ pluginId: id, err: String(err) }, 'init() failed');
      }
    }

    finalizeMenus(id);
  }

  const total = [...store.values()].reduce(
    (acc, entry) => ({
      menus: acc.menus + entry.extensions.menus.length,
      pages: acc.pages + entry.extensions.pages.length,
      surfaces: acc.surfaces + entry.extensions.surfaces.length,
      toolCards: acc.toolCards + entry.extensions.toolCards.length,
      routes: acc.routes + entry.extensions.routes.length,
      rejected: acc.rejected + entry.extensions.rejected.length,
    }),
    { menus: 0, pages: 0, surfaces: 0, toolCards: 0, routes: 0, rejected: 0 },
  );
  logger.info({ plugins: store.size, ...total }, 'plugin extensions loaded');
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
} {
  const menus: GlobalExtensionItem<MenuRegistration>[] = [];
  const pages: GlobalExtensionItem<PageRegistration>[] = [];
  for (const [pluginId, entry] of store) {
    for (const def of entry.extensions.menus) menus.push({ pluginId, def });
    for (const def of entry.extensions.pages) pages.push({ pluginId, def });
  }
  // 排序：显式 order 优先，其次 pluginId+id（稳定输出）
  menus.sort((a, b) => (a.def.order ?? Number.MAX_SAFE_INTEGER) - (b.def.order ?? Number.MAX_SAFE_INTEGER) || a.def.id.localeCompare(b.def.id));
  return { menus, pages };
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

/** 执行一次插件端点调用；未匹配返回 `null`。 */
export async function dispatchPluginRoute(
  id: string,
  ctx: DispatchContext,
  isEnabled: (pluginId: string) => boolean,
): Promise<PluginRouteResponse | 'not-enabled' | 'not-found' | null> {
  if (!isEnabled(id)) return 'not-enabled';
  const routes = store.get(id)?.routes;
  if (!routes || routes.length === 0) return null;
  const method = ctx.method.toUpperCase();
  const route = routes.find((r) => r.method === method && r.path === ctx.path);
  if (!route) return null;
  const request: PluginRouteRequest = {
    method,
    path: ctx.path,
    query: ctx.query,
    body: ctx.body,
    header: (name) => ctx.headers.get(name) ?? undefined,
  };
  const handler = route.handler as PluginRouteHandler;
  const result = await handler(request);
  return result ?? {};
}
