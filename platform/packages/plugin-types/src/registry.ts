/**
 * 插件注册表运行期辅助（`@pi-agent-platform/plugin-types/registry`）。
 *
 * 单独一个子路径入口：server 与 CLI 共用同一套读写逻辑，网页端永远不会把这些
 * node:fs 依赖打进 bundle（包根不 re-export 本文件）。
 *
 * 职责边界：
 * - 目录存在 = "文件在盘上"
 * - `registry.json` = "已登记 + 启停状态"
 * - 数据库 = 插件派生数据（本模块不碰）
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { PLUGIN_API_VERSION, PLUGIN_FACET_NAMES, PLUGIN_SLOT_NAMES } from './index.js';
import type {
  PluginFacetName,
  PluginManifest,
  PluginRegistryEntry,
  PluginRegistryFile,
  PluginStatus,
  SurfaceDeclaration,
} from './index.js';

export const REGISTRY_FILENAME = 'registry.json';

/** `<pluginsDir>/registry.json` */
export function registryPath(pluginsDir: string): string {
  return path.join(pluginsDir, REGISTRY_FILENAME);
}

/** `<pluginsDir>/<id>` */
export function pluginDir(pluginsDir: string, id: string): string {
  return path.join(pluginsDir, id);
}

function emptyRegistry(): PluginRegistryFile {
  return { version: 1, plugins: [] };
}

/**
 * 读注册表。文件不存在 → 空注册表；JSON 损坏 → 抛出（由调用方决定降级策略）。
 */
export function readRegistry(pluginsDir: string): PluginRegistryFile {
  const file = registryPath(pluginsDir);
  if (!existsSync(file)) return emptyRegistry();
  const raw = readFileSync(file, 'utf-8');
  if (!raw.trim()) return emptyRegistry();
  const parsed = JSON.parse(raw) as Partial<PluginRegistryFile>;
  const plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
  return { version: 1, plugins: plugins.filter(isRegistryEntry) };
}

function isRegistryEntry(value: unknown): value is PluginRegistryEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<PluginRegistryEntry>;
  return typeof entry.id === 'string' && typeof entry.dir === 'string';
}

/** 原子写（tmp + rename），避免 CLI 与 server 交错时读到半个文件。 */
export function writeRegistry(pluginsDir: string, data: PluginRegistryFile): void {
  mkdirSync(pluginsDir, { recursive: true });
  const file = registryPath(pluginsDir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  renameSync(tmp, file);
}

export function findEntry(data: PluginRegistryFile, id: string): PluginRegistryEntry | undefined {
  return data.plugins.find((p) => p.id === id);
}

/** 插入或替换（按 id）。 */
export function upsertEntry(data: PluginRegistryFile, entry: PluginRegistryEntry): PluginRegistryFile {
  const plugins = data.plugins.filter((p) => p.id !== entry.id);
  plugins.push(entry);
  plugins.sort((a, b) => a.id.localeCompare(b.id));
  return { version: 1, plugins };
}

export function removeEntry(data: PluginRegistryFile, id: string): PluginRegistryFile {
  return { version: 1, plugins: data.plugins.filter((p) => p.id !== id) };
}

/**
 * 读 `package.json` 的插件清单字段。缺 `piServer.apiVersion` → 返回 null（视为不兼容）。
 */
export function readManifest(dir: string): PluginManifest | null {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) return null;
  let pkg: {
    name?: unknown;
    version?: unknown;
    piServer?: {
      apiVersion?: unknown;
      requires?: { plugins?: unknown };
      web?: { surfaces?: unknown };
    };
  };
  try {
    pkg = JSON.parse(readFileSync(file, 'utf-8')) as typeof pkg;
  } catch {
    return null;
  }
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') return null;
  const apiVersion = pkg.piServer?.apiVersion;
  if (typeof apiVersion !== 'string') return null;
  const requiresRaw = pkg.piServer?.requires?.plugins;
  const requiresPlugins: Record<string, string> = {};
  if (requiresRaw && typeof requiresRaw === 'object') {
    for (const [name, range] of Object.entries(requiresRaw as Record<string, unknown>)) {
      if (typeof range === 'string') requiresPlugins[name] = range;
    }
  }
  const surfaces = parseSurfaces(pkg.piServer?.web?.surfaces);
  return { name: pkg.name, version: pkg.version, apiVersion, requiresPlugins, surfaces };
}

/** 宽松解析槽位声明：字段不完整的条目直接丢弃（由上层报告）。 */
function parseSurfaces(raw: unknown): SurfaceDeclaration[] {
  if (!Array.isArray(raw)) return [];
  const out: SurfaceDeclaration[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Partial<SurfaceDeclaration>;
    if (typeof s.id !== 'string' || typeof s.mountKey !== 'string' || typeof s.title !== 'string') continue;
    if (typeof s.slot !== 'string' || !PLUGIN_SLOT_NAMES.includes(s.slot as SurfaceDeclaration['slot'])) continue;
    out.push({
      id: s.id,
      slot: s.slot as SurfaceDeclaration['slot'],
      mountKey: s.mountKey,
      title: s.title,
      icon: typeof s.icon === 'string' ? s.icon : undefined,
      order: typeof s.order === 'number' ? s.order : undefined,
    });
  }
  return out;
}

/** 该目录实际存在哪些 facet（目录约定即声明）。 */
export function detectFacets(dir: string): PluginFacetName[] {
  const found: PluginFacetName[] = [];
  for (const facet of PLUGIN_FACET_NAMES) {
    const facetDir = path.join(dir, facet);
    if (!dirExists(facetDir)) continue;
    if (facet === 'web') {
      // web facet 没有固定入口名：槽位注册时用 `web/<mountKey>.js` → 目录里有 .js 即可
      const hasScript = existsSync(facetDir)
        && readdirSync(facetDir).some((name) => name.endsWith('.js'));
      if (hasScript) found.push(facet);
      continue;
    }
    if (existsSync(path.join(facetDir, 'index.js'))) found.push(facet);
  }
  return found;
}

/** 列出 `<pluginsDir>` 下像插件包的目录（有 package.json）。 */
export function scanPluginDirs(pluginsDir: string): string[] {
  if (!existsSync(pluginsDir)) return [];
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(path.join(pluginsDir, name, 'package.json')))
    .map((name) => path.join(pluginsDir, name));
}

/** 目录存在性 + 是否目录（避免把文件当插件）。 */
export function dirExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** 删除插件目录（`plugin remove --purge`）。 */
export function deletePluginDir(pluginsDir: string, id: string): void {
  rmSync(pluginDir(pluginsDir, id), { recursive: true, force: true });
}

export interface PluginState {
  status: PluginStatus;
  reason?: string;
  facets: Partial<Record<PluginFacetName, boolean>>;
  manifest: PluginManifest | null;
}

/**
 * 计算注册表条目的当前状态（不含会话级闸门——那是 server 侧按 agent 解析的）。
 *
 * 规则：
 * - 未登记（本函数不适用）→ `orphan` 由调用方判定
 * - `enabled: false` → `disabled`
 * - 目录消失 / 清单读不出来 / apiVersion 不匹配 → `degraded`
 * - 否则 `active`
 */
export function describePluginState(entry: PluginRegistryEntry): PluginState {
  const facets: Partial<Record<PluginFacetName, boolean>> = {};
  if (!entry.enabled) {
    return { status: 'disabled', reason: '已在 registry 中停用', facets, manifest: null };
  }
  const manifest = readManifest(entry.dir);
  if (!dirExists(entry.dir)) {
    return { status: 'degraded', reason: `安装目录不存在: ${entry.dir}`, facets, manifest };
  }
  if (!manifest) {
    return { status: 'degraded', reason: 'package.json 缺失或缺少 piServer.apiVersion', facets, manifest };
  }
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    return {
      status: 'degraded',
      reason: `契约版本不匹配: 插件 ${manifest.apiVersion} / 平台 ${PLUGIN_API_VERSION}`,
      facets,
      manifest,
    };
  }
  const detected = detectFacets(entry.dir);
  for (const facet of PLUGIN_FACET_NAMES) {
    const switchedOn = entry.facets?.[facet] !== false;
    facets[facet] = switchedOn && detected.includes(facet);
  }
  if (!Object.values(facets).some(Boolean)) {
    return { status: 'degraded', reason: '没有任何可加载的 facet（server/ worker/ extension/ web/）', facets, manifest };
  }
  return { status: 'active', facets, manifest };
}

// ---------- 互斥锁 ----------

export interface RegistryLock {
  release(): void;
}

/** 锁文件超过该时长视为陈旧（CLI 崩溃残留）。 */
const LOCK_STALE_MS = 120_000;

/**
 * 抢占注册表互斥锁（同一时间只允许一个 CLI 写 registry）。
 * 失败返回 null，调用方决定提示后退出。
 */
export function acquireRegistryLock(pluginsDir: string): RegistryLock | null {
  mkdirSync(pluginsDir, { recursive: true });
  const lockFile = path.join(pluginsDir, '.registry.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' });
      return {
        release(): void {
          try {
            rmSync(lockFile, { force: true });
          } catch {
            /* 已释放 */
          }
        },
      };
    } catch {
      // 已存在：判断是否陈旧
      try {
        const raw = JSON.parse(readFileSync(lockFile, 'utf-8')) as { at?: number };
        const age = Date.now() - (raw.at ?? 0);
        if (age > LOCK_STALE_MS) {
          rmSync(lockFile, { force: true });
          continue;
        }
      } catch {
        /* 读不出来按陈旧处理 */
        rmSync(lockFile, { force: true });
        continue;
      }
      return null;
    }
  }
  return null;
}

/** 读-改-写注册表，全程持锁。 */
export function withRegistry<T>(
  pluginsDir: string,
  mutate: (data: PluginRegistryFile) => { data: PluginRegistryFile; result: T },
): { ok: true; result: T } | { ok: false; reason: string } {
  const lock = acquireRegistryLock(pluginsDir);
  if (!lock) return { ok: false, reason: '注册表被另一个进程锁定（等待 2 分钟后重试）' };
  try {
    const current = readRegistry(pluginsDir);
    const { data, result } = mutate(current);
    writeRegistry(pluginsDir, data);
    return { ok: true, result };
  } finally {
    lock.release();
  }
}
