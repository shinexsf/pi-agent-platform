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
import { FACET_SUPPORT, PLUGIN_API_VERSION, PLUGIN_FACET_NAMES } from './index.js';
import type {
  FacetEntryPoint,
  PluginFacetName,
  PluginManifest,
  PluginRegistryEntry,
  PluginRegistryFile,
  PluginStatus,
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
    description?: unknown;
    author?: unknown;
    homepage?: unknown;
    piServer?: {
      apiVersion?: unknown;
      requires?: { plugins?: unknown };
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
  return {
    name: pkg.name,
    version: pkg.version,
    apiVersion,
    requiresPlugins,
    description: typeof pkg.description === 'string' ? pkg.description : undefined,
    author: parseAuthor(pkg.author),
    homepage: typeof pkg.homepage === 'string' ? pkg.homepage : undefined,
  };
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

/** `author` 既可能是字符串，也可能是 `{ name, email }`；只保留展示所需的字符串。 */
function parseAuthor(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object') {
    const name = (raw as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

/**
 * 该目录**声明**了哪些 facet —— 只看目录是否存在，不看入口文件。
 *
 * 与 {@link detectFacets} 的区别：后者要求入口文件真的在（= 可加载），
 * 前者只表达"作者声明了这一类扩展点"。目录页需要把两者分开呈现，
 * 否则"声明了但没编译"这种最常见的故障会被折叠成一个 false。
 */
export function listFacetDirs(dir: string): PluginFacetName[] {
  return PLUGIN_FACET_NAMES.filter((facet) => dirExists(path.join(dir, facet)));
}

/**
 * 探测某个 facet 的入口文件。
 *
 * - 非 web：`<dir>/<facet>/index.js`（约定）→ `<dir>/dist/<facet>/index.js`（构建产物布局）
 * - web：没有固定入口名，约定是 `<dir>/web/<mountKey>.js`，这里只判断目录里有没有 `.js`
 */
export function detectFacetEntry(dir: string, facet: PluginFacetName): FacetEntryPoint {
  if (facet === 'web') {
    const webDir = path.join(dir, 'web');
    const expected = path.join(webDir, '<mountKey>.js');
    let exists = false;
    try {
      exists = dirExists(webDir) && readdirSync(webDir).some((name) => name.endsWith('.js'));
    } catch {
      exists = false;
    }
    return { path: expected, exists, candidates: [expected] };
  }
  const candidates = [path.join(dir, facet, 'index.js'), path.join(dir, 'dist', facet, 'index.js')];
  const found = candidates.find((candidate) => existsSync(candidate));
  return { path: found ?? candidates[0]!, exists: Boolean(found), candidates };
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
  /** 开关 ∧ 声明（可加载）；保留旧语义，供既有消费方使用。 */
  facets: Partial<Record<PluginFacetName, boolean>>;
  /** 磁盘上声明了哪些 facet（只看目录存在，不看入口与开关）。 */
  declaredFacets: PluginFacetName[];
  /** registry 里显式关闭的 facet（原样，未与声明求交）。 */
  switches: Partial<Record<PluginFacetName, boolean>>;
  /** 各 facet 的入口文件探测结果。 */
  entries: Partial<Record<PluginFacetName, FacetEntryPoint>>;
  /** 平台实际会装载的 facet（开关 ∧ 声明 ∧ 平台支持 ∧ 入口存在）。 */
  loadedFacets: PluginFacetName[];
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
  const switches: Partial<Record<PluginFacetName, boolean>> = { ...(entry.facets ?? {}) };
  const entries: Partial<Record<PluginFacetName, FacetEntryPoint>> = {};

  // 目录探测与入口探测都不依赖开关：先算出来，这样"停用"的插件也能看到它声明了什么。
  const declaredFacets = listFacetDirs(entry.dir);
  for (const facet of PLUGIN_FACET_NAMES) entries[facet] = detectFacetEntry(entry.dir, facet);

  const base = { facets, declaredFacets, switches, entries, loadedFacets: [] as PluginFacetName[] };

  if (!entry.enabled) {
    return { ...base, status: 'disabled', reason: '已在 registry 中停用', manifest: null };
  }
  const manifest = readManifest(entry.dir);
  if (!dirExists(entry.dir)) {
    return {
      ...base,
      status: 'degraded',
      reason: `安装目录不存在: ${entry.dir}`,
      manifest,
    };
  }
  if (!manifest) {
    return {
      ...base,
      status: 'degraded',
      reason: 'package.json 缺失或缺少 piServer.apiVersion',
      manifest,
    };
  }
  if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    return {
      ...base,
      status: 'degraded',
      reason: `契约版本不匹配: 插件 ${manifest.apiVersion} / 平台 ${PLUGIN_API_VERSION}`,
      manifest,
    };
  }

  // 声明了目录却没有入口文件 —— 最常见的"编译产物没跟上来"故障，必须单独报。
  const missingEntry = declaredFacets.filter((facet) => !entries[facet]?.exists);
  const detected = detectFacets(entry.dir);
  for (const facet of PLUGIN_FACET_NAMES) {
    const switchedOn = switches[facet] !== false;
    facets[facet] = switchedOn && detected.includes(facet);
  }
  const loadedFacets = PLUGIN_FACET_NAMES.filter(
    (facet) => facets[facet] === true && FACET_SUPPORT[facet] === 'loaded',
  );

  if (missingEntry.length > 0) {
    const first = entries[missingEntry[0]!]!;
    return {
      ...base,
      status: 'degraded',
      reason: `${missingEntry.join(' / ')} 缺少入口文件（期望 ${first.candidates.join(' 或 ')}）`,
      loadedFacets,
      manifest,
    };
  }
  if (!Object.values(facets).some(Boolean)) {
    return {
      ...base,
      status: 'degraded',
      reason: '没有任何可加载的 facet（server/ worker/ extension/ web/）',
      loadedFacets,
      manifest,
    };
  }
  return { ...base, status: 'active', loadedFacets, manifest };
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
