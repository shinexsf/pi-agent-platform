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

import { existsSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import {
  describePluginState,
  readManifest,
  readRegistry,
  scanPluginDirs,
} from '@pi-agent-platform/plugin-types/registry';
import type {
  PluginFacetName,
  PluginManifest,
  PluginRegistryEntry,
  PluginStatus,
  ResolvedPlugin,
  SurfaceDeclaration,
} from '@pi-agent-platform/plugin-types';
import type { PluginEntryDTO } from '@pi-agent-platform/api-types';
import { childLogger } from '../logger.js';

const logger = childLogger('plugins');

export interface LoadedPlugin {
  entry: PluginRegistryEntry;
  status: PluginStatus;
  reason?: string;
  facets: Partial<Record<PluginFacetName, boolean>>;
  manifest: PluginManifest | null;
  /** 已校验的槽位（slot 合法、mountKey 文件存在、id 全局唯一）。 */
  slots: SurfaceDeclaration[];
}

export interface PluginSnapshot {
  plugins: LoadedPlugin[];
  /** 全局 kill switch 是否生效。 */
  disabledByFlag: boolean;
  /** 注册表文件路径，便于日志/调试。 */
  registryPath: string;
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
export function loadPlugins(pluginsDir: string): PluginSnapshot {
  const registryPath = path.join(pluginsDir, 'registry.json');
  const disabledByFlag = killSwitchActive();
  if (disabledByFlag) {
    logger.info({ pluginsDir }, 'plugins disabled by PI_PLUGINS flag');
    return { plugins: [], disabledByFlag, registryPath };
  }

  let file;
  try {
    file = readRegistry(pluginsDir);
  } catch (err) {
    logger.error({ err: String(err), registryPath }, 'failed to read plugin registry — continuing with no plugins');
    return { plugins: [], disabledByFlag, registryPath };
  }

  const plugins: LoadedPlugin[] = [];
  const usedSlotIds = new Set<string>();

  for (const entry of file.plugins) {
    const state = describePluginState(entry);
    const slots: SurfaceDeclaration[] = [];
    if (state.facets.web && state.manifest) {
      for (const surface of state.manifest.surfaces) {
        if (usedSlotIds.has(surface.id)) {
          logger.warn({ pluginId: entry.id, surfaceId: surface.id }, 'duplicate surface id — ignored');
          continue;
        }
        const script = path.join(entry.dir, 'web', `${surface.mountKey}.js`);
        if (!existsSync(script)) {
          logger.warn({ pluginId: entry.id, surfaceId: surface.id, script }, 'surface mountKey has no script — ignored');
          continue;
        }
        usedSlotIds.add(surface.id);
        slots.push(surface);
      }
    }
    plugins.push({ entry, status: state.status, reason: state.reason, facets: state.facets, manifest: state.manifest, slots });
  }

  // 目录存在但未登记 → orphan（不加载）
  const registered = new Set(file.plugins.map((p) => path.resolve(p.dir)));
  for (const dir of scanPluginDirs(pluginsDir)) {
    if (registered.has(path.resolve(dir))) continue;
    const manifest = readManifest(dir);
    plugins.push({
      entry: { id: path.basename(dir), version: manifest?.version ?? '?', dir, enabled: false },
      status: 'orphan',
      reason: '目录存在但未在 registry.json 登记（用 pi-server plugin add 重新登记）',
      facets: {},
      manifest,
      slots: [],
    });
  }

  logger.info(
    { count: plugins.length, active: plugins.filter((p) => p.status === 'active').length, registryPath },
    'plugin snapshot loaded',
  );
  return { plugins, disabledByFlag, registryPath };
}

/** 转成对外的只读 DTO。 */
export function toPluginEntryDTO(plugin: LoadedPlugin): PluginEntryDTO {
  return {
    id: plugin.entry.id,
    version: plugin.entry.version,
    status: plugin.status,
    reason: plugin.reason,
    facets: plugin.facets,
    slots: plugin.slots,
  };
}

/**
 * 会话级闸门解析。
 *
 * 通过条件：pack 已启用 + 全部 `requires.plugins` 既已装在 pi、又在该 agent 的
 * `extensions` 白名单里。**校验失败不代勾**。
 *
 * @param installedPiExtensions pi 里已安装的 pi 插件名（settings.json 的 packages/extensions）
 * @param agentExtensions       该 agent 允许使用的 pi 插件名（`config.extensions`）
 */
export function resolveSessionPlugins(options: {
  snapshot: PluginSnapshot;
  agentExtensions: readonly string[];
  installedPiExtensions: readonly string[];
}): ResolvedPlugin[] {
  const { snapshot, agentExtensions, installedPiExtensions } = options;
  if (snapshot.disabledByFlag) return [];

  const installed = new Set(installedPiExtensions.map((n) => n.toLowerCase()));
  const enabledByAgent = new Set(agentExtensions.map((n) => n.toLowerCase()));

  return snapshot.plugins.map((plugin) => {
    const base = { id: plugin.entry.id, dir: plugin.entry.dir };
    if (plugin.status !== 'active') {
      return { ...base, enabled: false, reason: plugin.reason ?? `status: ${plugin.status}` };
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
    return { ...base, enabled: true, extensionPath, workerPath };
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
export function getPluginSnapshot(pluginsDir: string): PluginSnapshot {
  const now = Date.now();
  if (cached && now - cached.at < SNAPSHOT_TTL_MS) return cached.snapshot;
  const snapshot = loadPlugins(pluginsDir);
  cached = { snapshot, at: now };
  return snapshot;
}

/** 强制失效（注册表变化时调用）。 */
export function invalidatePluginSnapshot(): void {
  cached = null;
}

/**
 * 启动插件运行期：装载一次 + 监听注册表变化。
 * 返回停止函数。
 */
export function startPluginRuntime(pluginsDir: string): () => void {
  invalidatePluginSnapshot();
  getPluginSnapshot(pluginsDir);
  const stopWatch = watchRegistry(pluginsDir, () => {
    invalidatePluginSnapshot();
    const snapshot = getPluginSnapshot(pluginsDir);
    logger.info(
      { count: snapshot.plugins.length, active: snapshot.plugins.filter((p) => p.status === 'active').length },
      'plugin registry changed — snapshot reloaded (server/web facets take effect now; worker/extension facets on next spawn)',
    );
  });
  return stopWatch;
}
