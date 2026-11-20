/**
 * 插件加载与会话级闸门（change: plugin-mechanism，骨架）。
 *
 * 职责：
 * - 读 `registry.json` + 扫安装目录（孤儿检测），算出每个插件的运行时状态
 * - 按会话解析可用插件集合（`requires.plugins` 校验，**绝不代勾**）
 * - 监听注册表变化（server / web facet 立即生效；worker / extension 待下次 spawn）
 *
 * 不负责：facet 的实际装载（server facet 装载不在本 change 范围；extension/worker
 * 由 worker 侧按 spawn 参数装载）。
 */

import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import {
  describePluginState,
  readManifest,
  readRegistry,
  scanPluginDirs,
  scanSkillPaths,
  detectFacetEntry,
  listFacetDirs,
} from '../plugins/registry.js';
import { isTombstoned, resolveRegistryFile } from '../plugins/registry.js';
import { FACET_SUPPORT, PLUGIN_FACET_NAMES } from '../plugins/constants.js';
import type {
  FacetEntryPoint,
  PluginFacetName,
  PluginManifest,
  PluginRegistryEntry,
  PluginStatus,
  ResolvedPlugin,
} from '@pi-agent-platform/plugin-types';
import type {
  PluginDependencyDTO,
  PluginDetailDTO,
  PluginEntryDTO,
} from '@pi-agent-platform/api-types';
import { coreConfig } from '../config.js';
import { childLogger } from '../logger.js';
import { extensionSummary, loadPluginExtensions, type ExtensionSummary, type PluginRuntimeDeps } from './plugin-extensions.js';

const logger = childLogger('plugins');

export interface LoadedPlugin {
  entry: PluginRegistryEntry;
  /** `bundled` = 随包分发（目录存在即生效）；`user` = 用户在 registry 登记。 */
  source: 'bundled' | 'user';
  status: PluginStatus;
  reason?: string;
  /** 开关 ∧ 声明 ∧ 入口（可加载）。 */
  facets: Partial<Record<PluginFacetName, boolean>>;
  /** 磁盘上声明了哪些 facet（只看目录）。 */
  declaredFacets: PluginFacetName[];
  /** registry 里显式关闭的 facet（原样）。 */
  switches: Partial<Record<PluginFacetName, boolean>>;
  /** 各 facet 的入口探测结果。 */
  entries: Partial<Record<PluginFacetName, FacetEntryPoint>>;
  /** 平台实际会装载的 facet。 */
  loadedFacets: PluginFacetName[];
  /** 插件自带的 skill 目录（`skills/*\/SKILL.md` 的父目录；不是 facet）。 */
  skillPaths: string[];
  manifest: PluginManifest | null;
}

export interface PluginSnapshot {
  plugins: LoadedPlugin[];
  /** 全局 kill switch 是否生效。 */
  disabledByFlag: boolean;
  /** 注册表文件路径，便于日志/调试。 */
  registryPath: string;
  /** 本次扫描的 bundled 目录（无 bundled 时为 undefined）。 */
  bundledDir?: string;
}

/** `PI_PLUGINS=0` 关闭全部插件（回退开关）。 */
export function killSwitchActive(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PI_PLUGINS;
  return raw === '0' || raw === 'false' || raw === 'off';
}

/**
 * 装载快照。
 *
 * - `enabled: false` → `disabled`
 * - 目录缺失 / 清单坏 / 契约版本不符 → `degraded`
 * - 有目录未登记 → 额外产出 `orphan` 条目（不加载，仅供展示）
 */
export function loadPlugins(pluginsDir: string, bundledDir?: string): PluginSnapshot {
  const registryFile = resolveRegistryFile(pluginsDir);
  const disabledByFlag = killSwitchActive();
  const bundledRoot = bundledDir ? path.resolve(bundledDir) : undefined;
  if (disabledByFlag) {
    logger.info({ pluginsDir }, 'plugins disabled by PI_PLUGINS flag');
    return { plugins: [], disabledByFlag, registryPath: registryFile, bundledDir: bundledRoot };
  }

  let file;
  try {
    file = readRegistry(registryFile);
  } catch (err) {
    logger.error({ err: String(err), registryFile }, 'failed to read plugin registry — continuing with no plugins');
    return { plugins: [], disabledByFlag, registryPath: registryFile, bundledDir: bundledRoot };
  }

  const insideBundled = (dir: string): boolean => {
    if (!bundledRoot) return false;
    const abs = path.resolve(dir);
    return abs === bundledRoot || abs.startsWith(bundledRoot + path.sep);
  };

  const toLoaded = (entry: PluginRegistryEntry, source: LoadedPlugin['source']): LoadedPlugin => {
    const state = describePluginState(entry);
    return {
      entry,
      source,
      status: state.status,
      reason: state.reason,
      facets: state.facets,
      declaredFacets: state.declaredFacets,
      switches: state.switches,
      entries: state.entries,
      loadedFacets: state.loadedFacets,
      skillPaths: state.skillPaths ?? [],
      manifest: state.manifest,
    };
  };

  // ── 1. bundled：目录存在即生效（墓碑挡掉已卸载的） ──────────────────────
  const plugins: LoadedPlugin[] = [];
  const byId = new Map<string, LoadedPlugin>();
  const tombstoned: string[] = [];
  if (bundledRoot) {
    for (const dir of scanPluginDirs(bundledRoot)) {
      const id = path.basename(dir);
      if (isTombstoned(file, id)) {
        tombstoned.push(id);
        continue;
      }
      const loaded = toLoaded({ id, dir, enabled: true }, 'bundled');
      plugins.push(loaded);
      byId.set(id, loaded);
    }
  }

  // ── 2. 用户插件：只有登记过才装载 ────────────────────────────────────────
  for (const entry of file.plugins) {
    // 旧 registry 里可能残留 bundled 条目（v1 把所有插件都登记进去）——
    // 现在 bundled 走目录扫描，这些条目直接丢弃，避免同一插件被装两遍。
    if (insideBundled(entry.dir)) {
      logger.info({ pluginId: entry.id }, 'registry 里的 bundled 条目已废弃（bundled 改为目录扫描）');
      continue;
    }
    const existing = byId.get(entry.id);
    if (existing) {
      // 同 id 冲突：bundled 优先（平台随包的东西不允许被用户目录覆盖）。
      logger.warn(
        { pluginId: entry.id, bundledDir: existing.entry.dir, userDir: entry.dir },
        'bundled 与用户插件同 id —— 以 bundled 为准，用户那份被忽略',
      );
      continue;
    }
    const loaded = toLoaded(entry, 'user');
    plugins.push(loaded);
    byId.set(entry.id, loaded);
  }

  // ── 3. 用户目录里未登记的 → orphan（不加载，只展示） ─────────────────────
  const registered = new Set(file.plugins.map((p) => path.resolve(p.dir)));
  for (const dir of scanPluginDirs(pluginsDir)) {
    if (registered.has(path.resolve(dir))) continue;
    const id = path.basename(dir);
    if (byId.has(id)) continue;
    const manifest = readManifest(dir);
    const entries: Partial<Record<PluginFacetName, FacetEntryPoint>> = {};
    for (const facet of PLUGIN_FACET_NAMES) entries[facet] = detectFacetEntry(dir, facet);
    const declaredFacets = listFacetDirs(dir);
    plugins.push({
      entry: { id, dir, enabled: false },
      source: 'user',
      status: 'orphan',
      reason: '目录存在但未在 registry.json 登记（用 pi-server plugin add 重新登记）',
      facets: {},
      declaredFacets,
      switches: {},
      entries,
      loadedFacets: [],
      skillPaths: scanSkillPaths(dir),
      manifest,
    });
    byId.set(id, plugins[plugins.length - 1]!);
  }

  logger.info(
    {
      count: plugins.length,
      active: plugins.filter((p) => p.status === 'active').length,
      bundled: plugins.filter((p) => p.source === 'bundled').length,
      tombstoned: tombstoned.length,
      registryFile,
    },
    'plugin snapshot loaded',
  );
  return { plugins, disabledByFlag, registryPath: registryFile, bundledDir: bundledRoot };
}

/** 转成对外的只读 DTO。 */
export function toPluginEntryDTO(plugin: LoadedPlugin): PluginEntryDTO {
  const manifest = plugin.manifest;
  return {
    id: plugin.entry.id,
    version: manifest?.version ?? '?',
    source: plugin.source,
    status: plugin.status,
    reason: plugin.reason,
    description: manifest?.description,
    author: manifest?.author,
    homepage: manifest?.homepage,
    facets: plugin.facets,
    declaredFacets: plugin.declaredFacets,
    switches: plugin.switches,
    loadedFacets: plugin.loadedFacets,
    entries: Object.fromEntries(
      PLUGIN_FACET_NAMES.map((facet) => [facet, detectFacetEntry(plugin.entry.dir, facet)]),
    ) as Record<PluginFacetName, FacetEntryPoint>,
    requires: manifest?.requiresPlugins ?? {},
    dir: plugin.entry.dir,
  };
}

/**
 * 判定一个 pi 插件是否已安装。
 *
 * 判定顺序（与 pi 自己的解析一致）：
 * 1. `<agentDir>/settings.json` 的 `packages`（剥 `npm:` 前缀）—— 用户显式装的
 * 2. `<agentDir>/npm/node_modules/<pkg>` —— 安装产物落地
 *
 * 两者都查不到 → `false`；settings 读不出来 → `null`（"我不知道" ≠ "没装"）。
 */
export function resolveDependency(
  name: string,
  range: string,
  agentDir: string,
): PluginDependencyDTO {
  let settingsReadable = true;
  let packages: string[] = [];
  try {
    const raw = readFileSync(path.join(agentDir, 'settings.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { packages?: unknown };
    if (Array.isArray(parsed.packages)) {
      packages = parsed.packages.filter((p): p is string => typeof p === 'string');
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // 文件不存在 = 没装任何扩展，这是可判定的 false；其它错误才算"未知"。
    if (code !== 'ENOENT') settingsReadable = false;
  }

  const stripNpm = (spec: string) => spec.replace(/^npm:/, '');
  if (packages.some((spec) => stripNpm(spec).split('@')[0] === name || stripNpm(spec).startsWith(`${name}@`) || stripNpm(spec) === name)) {
    return { name, range, installed: true, via: 'settings', version: readInstalledVersion(agentDir, name) };
  }

  const nested = path.join(agentDir, 'npm', 'node_modules', name, 'package.json');
  if (existsSync(nested)) {
    return { name, range, installed: true, via: 'node_modules', version: readInstalledVersion(agentDir, name) };
  }

  return { name, range, installed: settingsReadable ? false : null };
}

/** 读 `<agentDir>/npm/node_modules/<pkg>/package.json` 的版本（读不到就不报版本）。 */
function readInstalledVersion(agentDir: string, name: string): string | undefined {
  try {
    const raw = readFileSync(path.join(agentDir, 'npm', 'node_modules', name, 'package.json'), 'utf-8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof version === 'string' ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 单个插件的详情视图：声明 + 入口探测 + 依赖安装状态。
 *
 * 只读：不写 registry、不动目录。`null` 表示 registry 里没有这个 id。
 */
export function describePluginDetail(
  pluginsDir: string,
  id: string,
  agentDir: string,
): PluginDetailDTO | null {
  const snapshot = getPluginSnapshot(pluginsDir);
  const plugin = snapshot.plugins.find((p) => p.entry.id === id);
  if (!plugin) return null;

  // 入口探测每次现读：编译产物可能刚被重新构建，缓存会让页面说谎。
  const entryPoints = Object.fromEntries(
    PLUGIN_FACET_NAMES.map((facet) => [facet, detectFacetEntry(plugin.entry.dir, facet)]),
  ) as Record<PluginFacetName, FacetEntryPoint>;

  const dependencies = Object.entries(plugin.manifest?.requiresPlugins ?? {}).map(([name, range]) =>
    resolveDependency(name, range, agentDir),
  );

  return {
    plugin: toPluginEntryDTO(plugin),
    entryPoints,
    dependencies,
    manifestPath: path.join(plugin.entry.dir, 'package.json'),
    registryEntry: {
      id: plugin.entry.id,
      dir: plugin.entry.dir,
      enabled: plugin.entry.enabled,
      source: plugin.source,
      /** bundled 插件不在 registry 里 —— 它靠目录存在生效，卸载靠墓碑。 */
      inRegistry: plugin.source === 'user',
    },
  };
}

/** facet → 装载支持度（`server` 本期为 `declared-only`）。 */
export function facetSupportMap(): Record<PluginFacetName, 'loaded' | 'declared-only'> {
  return { ...FACET_SUPPORT };
}

/**
 * 会话级闸门解析。
 *
 * 通过条件（全部满足）：
 * 1. 插件在 registry/bundled 里处于 active
 * 2. **该 agent 的 `plugins` 启用列表里有它**（缺失即空 = 一个都不启用）
 * 3. 全部 `requires.plugins`（pi 扩展名）既已装在 pi、又在该 agent 的 `extensions` 里
 *
 * 校验失败不代勾：**声明 ≠ 启用**。
 *
 * @param enabledPlugins        该 agent 启用的平台插件 id（`config.plugins`）
 * @param installedPiExtensions pi 里已安装的 pi 插件名（settings.json 的 packages/extensions）
 * @param agentExtensions       该 agent 允许使用的 pi 插件名（`config.extensions`）
 */
export function resolveSessionPlugins(options: {
  snapshot: PluginSnapshot;
  enabledPlugins?: readonly string[];
  agentExtensions: readonly string[];
  installedPiExtensions: readonly string[];
}): ResolvedPlugin[] {
  const { snapshot, enabledPlugins, agentExtensions, installedPiExtensions } = options;
  if (snapshot.disabledByFlag) return [];

  const installed = new Set(installedPiExtensions.map((n) => n.toLowerCase()));
  const enabledByAgent = new Set(agentExtensions.map((n) => n.toLowerCase()));
  const chosen = new Set((enabledPlugins ?? []).map((id) => id.toLowerCase()));

  return snapshot.plugins.map((plugin) => {
    const base = { id: plugin.entry.id, dir: plugin.entry.dir };
    if (plugin.status !== 'active') {
      return { ...base, enabled: false, reason: plugin.reason ?? `status: ${plugin.status}` };
    }
    // 该 agent 没启用这个插件 → 会话内能力（工具/命令/钩子/skill）全部不注入。
    // server / web facet 是进程级全局资源，不受这里影响。
    if (!chosen.has(plugin.entry.id.toLowerCase())) {
      return { ...base, enabled: false, reason: '该 agent 未启用此插件' };
    }
    const missing = Object.keys(plugin.manifest?.requiresPlugins ?? {}).filter((name) => {
      const key = name.toLowerCase();
      if (!installed.has(key)) return true;
      return !enabledByAgent.has(key);
    });
    if (missing.length > 0) {
      return { ...base, enabled: false, reason: `依赖未启用: ${missing.join(', ')}` };
    }
    const extensionPath = plugin.facets.extension ? path.join(plugin.entry.dir, 'extension', 'index.js') : undefined;
    const workerPath = plugin.facets.worker ? path.join(plugin.entry.dir, 'worker', 'index.js') : undefined;
    // skill 与工具**同源生效**：插件对会话生效 → 自动获得，不占 agent 配置项。
    return { ...base, enabled: true, extensionPath, workerPath, skillPaths: plugin.skillPaths ?? [] };
  });
}

/**
 * 监听 registry.json 变化。
 * 返回停止函数。文件被原子写替换时目录监听仍有效。
 */
export function watchRegistry(pluginsDir: string, onChange: () => void): () => void {
  let watcher: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;

  const emit = (): void => {
    if (timer) clearTimeout(timer);
    // 原子写会先产生 tmp 文件再 rename，合并短时间内的多次事件
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, 150);
  };

  try {
    watcher = watch(pluginsDir, { persistent: false }, (_event, filename) => {
      if (!filename || String(filename).startsWith('registry.json')) emit();
    });
    watcher.on('error', (err) => logger.warn({ err: String(err) }, 'registry watcher error'));
  } catch (err) {
    logger.warn({ err: String(err), pluginsDir }, 'failed to watch plugin registry (server facets will not hot-reload)');
  }

  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}

// ---------- 运行期快照缓存 ----------

let cached: { snapshot: PluginSnapshot; at: number } | null = null;
const SNAPSHOT_TTL_MS = 1_000;

/** 读快照（默认 1s 缓存，watcher 会主动失效）。 */
/** bundled 目录来自内核配置（入口注入）；未初始化配置时退化为"没有 bundled 插件"。 */
function configuredBundledDir(): string | undefined {
  try {
    return coreConfig().bundledPluginsDir;
  } catch {
    return undefined;
  }
}

export function getPluginSnapshot(pluginsDir: string): PluginSnapshot {
  const now = Date.now();
  if (cached && now - cached.at < SNAPSHOT_TTL_MS) return cached.snapshot;
  const snapshot = loadPlugins(pluginsDir, configuredBundledDir());
  cached = { snapshot, at: now };
  return snapshot;
}

/** 强制失效（注册表变化时调用）。 */
export function invalidatePluginSnapshot(): void {
  cached = null;
}

// ---------- web facet 资源版本（前端动态 import 的 cache-busting） ----------

/**
 * 插件 `web/` 目录内容的版本串（最大 mtime + 总字节数）。
 *
 * 存在理由：浏览器按 **URL** 缓存 ES module，HTTP 的 `no-cache` 只能让网络层重取 ——
 * 同一个 URL 再 `import()` 拿到的仍是内存里那个模块。所以改完插件代码必须让 URL 变。
 * 用文件 mtime 而不是自增计数器：改文件/重装/reload 都会变，不依赖谁记得去递增。
 */
function webDirRevision(dir: string): string {
  let maxMtime = 0;
  let bytes = 0;
  const walk = (d: string, depth: number): void => {
    if (depth > 3) return;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = path.join(d, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs, depth + 1);
      else {
        if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
        bytes += st.size;
      }
    }
  };
  walk(path.join(dir, 'web'), 0);
  if (!maxMtime) return '0';
  return `${Math.round(maxMtime).toString(36)}-${bytes.toString(36)}`;
}

let revisionCache: { at: number; value: Record<string, string> } | null = null;
const REVISION_TTL_MS = 1_000;

/**
 * 全部可装载插件的 web 资源版本（插件 id → 版本串）。
 *
 * 前端把它拼成 `/plugins/<id>/web/<entry>.js?v=<rev>`，于是 `plugin reload` / 重装 /
 * 直接改文件之后，下一次挂载拿到的必定是新模块（不需要手动清浏览器缓存）。
 */
export function pluginWebRevisions(pluginsDir: string): Record<string, string> {
  const now = Date.now();
  if (revisionCache && now - revisionCache.at < REVISION_TTL_MS) return revisionCache.value;
  const value: Record<string, string> = {};
  for (const plugin of getPluginSnapshot(pluginsDir).plugins) {
    const dir = plugin.entry.dir;
    if (!dir) continue;
    value[plugin.entry.id] = webDirRevision(dir);
  }
  revisionCache = { at: now, value };
  return value;
}

/**
 * 启动插件运行期：装载一次 + 监听注册表变化。
 *
 * 装载分两步：先算静态快照，再执行插件代码（`register()` / `init()`）。
 * 后者可能抛错/超时，所以整体是异步的。
 */
/** 运行期句柄：`stop()` 停监听，`reload()` 立刻按磁盘现状重装一遍（`plugin reload`）。 */
export interface PluginRuntimeHandle {
  stop(): void;
  reload(): Promise<ExtensionSummary>;
}

export async function startPluginRuntime(
  pluginsDir: string,
  deps: PluginRuntimeDeps,
): Promise<PluginRuntimeHandle> {
  invalidatePluginSnapshot();
  const snapshot = getPluginSnapshot(pluginsDir);
  await loadPluginExtensions(snapshot, deps);

  const reload = async (): Promise<ExtensionSummary> => {
    invalidatePluginSnapshot();
    const next = getPluginSnapshot(pluginsDir);
    await loadPluginExtensions(next, deps);
    logger.info(
      { count: next.plugins.length, active: next.plugins.filter((p) => p.status === 'active').length },
      'plugin runtime reloaded (server facets now; worker/extension facets on next spawn)',
    );
    return extensionSummary();
  };

  const stopWatch = watchRegistry(pluginsDir, () => {
    void reload().catch((err) => logger.error({ err: String(err) }, 'plugin extensions reload failed'));
  });
  return { stop: stopWatch, reload };
}
