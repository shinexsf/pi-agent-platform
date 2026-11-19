/**
 * `pi-server plugin` — 插件安装与注册（change: plugin-mechanism）。
 *
 * 设计约束：
 * - **安装只能走 CLI**：server 不暴露任何安装端点
 * - 插件就是一个 npm 包 + 目录约定；`registry.json` 是安装事实的唯一来源
 * - `dependencies` 装进插件自己的 `node_modules`；`peerDependencies`（pi 原生插件）
 *   **不装副本**，只建 junction/symlink 指向 pi 的安装目录（同一实例）
 * - 任一步失败都不写登记（避免"注册了跑不起来"的僵尸条目）
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import Database from 'better-sqlite3';
import {
  acquireRegistryLock,
  addTombstone,
  describePluginState,
  detectFacets,
  isTombstoned,
  pluginDir,
  readRegistry,
  removeEntry,
  removeTombstone,
  scanPluginDirs,
  upsertEntry,
  writeRegistry,
  withRegistry,
  deletePluginDir,
} from '@pi-agent-platform/core/plugins';
import { PLUGIN_API_VERSION } from '@pi-agent-platform/core/plugins';
import type { PluginRegistryFile } from '@pi-agent-platform/plugin-types';
import { error, log, warn } from '../logger.js';
import { resolveServerPort } from '../daemon.js';
import { bundledPluginsDir, databasePath, piNpmModulesDir, pluginRegistryFile, pluginsDir } from '../paths.js';
import { ensureVendoredTypes, PLUGIN_TYPES_VERSION, readVendoredTypesVersion } from '../plugin-types-vendor.js';

interface PackageJsonLike {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  piServer?: { apiVersion?: string; requires?: { plugins?: Record<string, string> } };
}

function readPackageJson(dir: string): PackageJsonLike | null {
  const file = path.join(dir, 'package.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as PackageJsonLike;
  } catch {
    return null;
  }
}

// ---------- 安装步骤 ----------

/** 1) 装私有依赖。没有 dependencies 就跳过（避免无网也跑一次 npm）。 */
function installDependencies(dir: string, pkg: PackageJsonLike): boolean {
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length === 0) {
    log(`no dependencies to install (${pkg.name})`);
    return true;
  }
  log(`installing ${deps.length} dependencies with --omit=dev …`);
  const res = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: dir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    error(`npm install failed (exit ${res.status ?? 'null'})`);
    return false;
  }
  return true;
}

/**
 * 2) 为 pi 原生插件依赖建链接（不装副本）。
 *
 * 目标不存在 → 记为 missing（由 requires.plugins 校验报告），不阻断安装。
 */
function linkPeerPlugins(dir: string, pkg: PackageJsonLike): { linked: string[]; missing: string[] } {
  const linked: string[] = [];
  const missing: string[] = [];
  const peers = Object.keys(pkg.peerDependencies ?? {});
  const piModules = piNpmModulesDir();

  for (const name of peers) {
    const target = path.join(piModules, name);
    if (!existsSync(target)) {
      missing.push(name);
      continue;
    }
    const linkPath = path.join(dir, 'node_modules', name);
    mkdirSync(path.dirname(linkPath), { recursive: true });
    // 已存在的实体副本（例如误用 --omit=dev 之前装过）先删掉，避免遮蔽链接
    if (existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true });
    // Windows 用 junction（免管理员），其它平台用目录 symlink
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    linked.push(name);
  }
  return { linked, missing };
}

/** 3) 校验链接真的指向 pi 的安装目录（防止悄悄用了副本）。 */
function verifyPeerLinks(dir: string, linked: string[]): string[] {
  const piModules = piNpmModulesDir();
  const bad: string[] = [];
  for (const name of linked) {
    try {
      const real = realpathSync(path.join(dir, 'node_modules', name));
      if (!real.startsWith(piModules)) bad.push(`${name} → ${real}`);
    } catch {
      bad.push(`${name}（无法解析）`);
    }
  }
  return bad;
}

// ---------- 子命令 ----------

export async function pluginAddCommand(rawDir: string): Promise<void> {
  const dir = path.resolve(rawDir);
  const pkg = readPackageJson(dir);
  if (!pkg) {
    error(`not a package directory (missing package.json): ${dir}`);
    process.exit(1);
  }
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
    error('package.json must declare name and version');
    process.exit(1);
  }
  const apiVersion = pkg.piServer?.apiVersion;
  if (typeof apiVersion !== 'string') {
    error(`package.json is missing "piServer.apiVersion" (expected "${PLUGIN_API_VERSION}")`);
    process.exit(1);
  }
  if (apiVersion !== PLUGIN_API_VERSION) {
    error(`apiVersion mismatch: plugin declares ${apiVersion}, platform expects ${PLUGIN_API_VERSION}`);
    process.exit(1);
  }

  const facets = detectFacets(dir);
  if (facets.length === 0) {
    error('no facet found — expected at least one of server/ worker/ extension/ web/ with index.js');
    process.exit(1);
  }

  // 先抢锁再装：避免白装一轮（也避免两个 CLI 同时链接同一目录）
  const lock = acquireRegistryLock(pluginsDir());
  if (!lock) {
    error('registry is locked by another process (retry in a couple of minutes)');
    process.exit(1);
  }
  try {
    if (!installDependencies(dir, pkg)) process.exit(1);

    const { linked, missing } = linkPeerPlugins(dir, pkg);
    if (linked.length > 0) log(`linked peer plugins → pi install: ${linked.join(', ')}`);
    if (missing.length > 0) {
      warn(`peer plugins not installed in pi: ${missing.join(', ')} — the plugin will not load for any session until they are`);
    }

    const badLinks = verifyPeerLinks(dir, linked);
    if (badLinks.length > 0) {
      warn(`peer link verification failed (a second copy may shadow pi's): ${badLinks.join('; ')}`);
    }

    // 安装前先机械校验：入口在不在、是不是 ESM、web 产物有没有裸说明符。
    // 失败就不写 registry —— 避免"登记了但跑不起来"的僵尸条目。
    const { checkPluginDir, formatCheckResult } = await import('@pi-agent-platform/core/plugins');
    const check = checkPluginDir(dir);
    if (!check.ok) {
      for (const line of formatCheckResult(check)) error(line);
      error('plugin check failed — nothing registered');
      process.exit(1);
    }
    ensureVendoredTypes(dir);

    const entry: PluginRegistryFile['plugins'][number] = { id: pkg.name as string, dir, enabled: true };
    const next = upsertEntry(readRegistry(pluginRegistryFile()), entry);
    writeRegistry(pluginRegistryFile(), next);

    log(`registered ${pkg.name}@${pkg.version} (facets: ${facets.join(', ')})`);
    log('restart the server, or wait for the registry watcher, to load it');
  } finally {
    lock.release();
  }
}

export async function pluginListCommand(): Promise<void> {
  const registry = pluginRegistryFile();
  const data = readRegistry(registry);
  const bundledRoot = bundledPluginsDir();
  const rows: string[] = [];
  const seen = new Set<string>();

  // bundled：目录存在即生效（墓碑挡掉的不列）
  for (const dir of scanPluginDirs(bundledRoot)) {
    const id = path.basename(dir);
    seen.add(id);
    if (isTombstoned(data, id)) {
      rows.push(`${id}  -  removed(bundled)  -  ${dir}  (已卸载；plugin enable 可恢复)`);
      continue;
    }
    const state = describePluginState({ id, dir, enabled: true });
    rows.push(formatRow(id, 'bundled', state));
  }

  for (const entry of data.plugins) {
    seen.add(entry.id);
    const state = describePluginState(entry);
    rows.push(formatRow(entry.id, 'user', state));
  }

  // 用户目录里有目录但没登记 → orphan
  for (const dir of scanPluginDirs(pluginsDir())) {
    const id = path.basename(dir);
    if (seen.has(id)) continue;
    rows.push(`${id}  -  orphan  -  -  -  ${dir}  (目录存在但未登记；用 plugin add 重新登记)`);
  }

  if (rows.length === 0) {
    log('no plugins installed');
    return;
  }
  process.stdout.write(`id  version  source  status  facets  dir\n${rows.join('\n')}\n`);
  process.stdout.write(`\nregistry: ${registry}\nbundled:  ${bundledRoot}\n`);
}

function formatRow(id: string, source: 'bundled' | 'user', state: ReturnType<typeof describePluginState>): string {
  const facetList =
    Object.entries(state.facets)
      .filter(([, on]) => on)
      .map(([name]) => name)
      .join(',') || '-';
  return [
    id,
    state.manifest?.version ?? '?',
    source,
    state.status,
    facetList,
    state.manifest ? '' : '(no package.json)',
    state.reason ? `(${state.reason})` : '',
  ]
    .filter(Boolean)
    .join('  ');
}

/** bundled 插件是否在盘上（用于决定 enable/disable/remove 走哪条路）。 */
function isBundled(id: string): boolean {
  return existsSync(path.join(bundledPluginsDir(), id, 'package.json'));
}

function setEnabled(id: string, enabled: boolean): void {
  if (isBundled(id)) {
    // bundled 的"停用/启用"= 墓碑的增删：目录不能删（随包分发），登记也不该有。
    const res = withRegistry(pluginRegistryFile(), (data) => ({
      data: enabled ? removeTombstone(data, id) : addTombstone(data, id),
      result: true,
    }));
    if (!res.ok) {
      error(`failed to write registry: ${res.reason}`);
      process.exit(1);
    }
    log(`${id} (bundled) ${enabled ? 'enabled' : 'disabled'}`);
    log('生效：server facet 立即（插件目录变化会被监听）；worker/pi 扩展 facet 待下次 spawn');
    return;
  }

  const res = withRegistry(pluginRegistryFile(), (data) => {
    const entry = data.plugins.find((p) => p.id === id);
    if (!entry) return { data, result: null };
    const next = data.plugins.map((p) => (p.id === id ? { ...p, enabled } : p));
    return { data: { ...data, plugins: next }, result: entry };
  });
  if (!res.ok) {
    error(`failed to write registry: ${res.reason}`);
    process.exit(1);
  }
  if (!res.result) {
    error(`plugin not installed: ${id}`);
    process.exit(1);
  }
  log(`${id} ${enabled ? 'enabled' : 'disabled'}`);
}

export async function pluginEnableCommand(id: string): Promise<void> {
  setEnabled(id, true);
}

export async function pluginDisableCommand(id: string): Promise<void> {
  setEnabled(id, false);
}

/** 读迁移台账，返回该插件登记过的表名（DB 不存在 / 表不存在 → 空）。 */
function pluginTables(id: string): string[] {
  const file = databasePath();
  if (!existsSync(file)) return [];
  try {
    const raw = new Database(file, { readonly: true });
    try {
      const rows = raw
        .prepare('SELECT name FROM plugin_migrations WHERE plugin_id = ? ORDER BY name')
        .all(id) as Array<{ name: string }>;
      return rows.map((r) => r.name);
    } finally {
      raw.close();
    }
  } catch {
    return [];
  }
}

/**
 * `plugin remove` —— 只删登记与墓碑，**数据一律保留**。
 *
 * bundled：写墓碑（目录随包分发，删了下次升级又回来，所以用墓碑表达"用户不要它"）。
 * user：删 registry 条目（`--purge` 才删目录）。
 * 两种都把"留下的表"打出来让用户自己决定 —— 自动删表不可逆，平台不做。
 */
export async function pluginRemoveCommand(id: string, opts: { purge?: boolean } = {}): Promise<void> {
  const bundled = isBundled(id);
  const tables = pluginTables(id);

  if (bundled) {
    const res = withRegistry(pluginRegistryFile(), (data) => ({
      data: addTombstone(data, id),
      result: true,
    }));
    if (!res.ok) {
      error(`failed to write registry: ${res.reason}`);
      process.exit(1);
    }
    log(`${id} (bundled) removed — 目录保留，墓碑已写入（升级不会复活；plugin enable 可恢复）`);
  } else {
    const res = withRegistry(pluginRegistryFile(), (data) => {
      const exists = data.plugins.some((p) => p.id === id);
      return { data: removeEntry(data, id), result: exists };
    });
    if (!res.ok) {
      error(`failed to write registry: ${res.reason}`);
      process.exit(1);
    }
    log(res.result ? `${id} unregistered` : `${id} was not registered (nothing to unregister)`);
    if (opts.purge) {
      const dir = pluginDir(pluginsDir(), id);
      if (existsSync(dir)) {
        deletePluginDir(pluginsDir(), id);
        log(`deleted ${dir}`);
      }
    } else {
      log('install directory kept (use --purge to delete it)');
    }
  }

  if (tables.length > 0) {
    log('');
    log(`留下的表（数据未删除，需要时自行清理）：${tables.join(', ')}`);
  }
}

/**
 * `pi-server plugin reload` —— 让运行中的 server 按磁盘现状重装插件（**不重启**）。
 *
 * 为什么需要它：插件**代码**变化不会被 registry 监听捕获（本期不监听插件目录）。
 * 生效边界：server facet 立即生效；worker / pi 扩展 facet 等下次 spawn；浏览器刷新。
 */
export async function pluginReloadCommand(opts: { port?: number } = {}): Promise<void> {
  const port = opts.port ?? resolveServerPort();
  const url = `http://localhost:${port}/api/extensions/reload`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let body: Record<string, unknown> | null = null;
  try {
    const res = await fetch(url, { method: 'POST', signal: ctrl.signal });
    body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      error(`reload failed (${res.status}): ${body ? JSON.stringify(body) : 'no body'}`);
      process.exit(1);
    }
  } catch (err) {
    error(`cannot reach server at ${url} — is it running? (${String(err)})`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }

  const s = body ?? {};
  log(
    `reloaded: plugins=${s.plugins ?? '?'} menus=${s.menus ?? '?'} pages=${s.pages ?? '?'} ` +
      `routes=${s.routes ?? '?'} rejected=${s.rejected ?? '?'} imports=${s.imports ?? '?'}`,
  );
  log('生效范围：server facet 已生效；worker / pi 扩展 facet 待下次 spawn；浏览器刷新即可');
}

/**
 * `pi-server plugin check <dir>` —— 安装前/排障用的机械校验。
 *
 * 与打包自检共用同一套规则（`core/plugins/check.ts`）：存在性 / ESM / 说明符白名单。
 * 顺便把 vendored 类型写进插件目录并比对版本。
 */
export async function pluginCheckCommand(dir: string): Promise<void> {
  const target = path.resolve(dir);
  const { checkPluginDir, formatCheckResult } = await import('@pi-agent-platform/core/plugins');
  const result = checkPluginDir(target);
  for (const line of formatCheckResult(result)) {
    if (line.includes('✗')) error(line);
    else if (line.includes('!')) warn(line);
    else log(line);
  }
  ensureVendoredTypes(target);
  const typesVersion = readVendoredTypesVersion(target);
  if (typesVersion && typesVersion !== PLUGIN_TYPES_VERSION) {
    error(`vendored types are stale (${typesVersion} ≠ ${PLUGIN_TYPES_VERSION})`);
    process.exit(1);
  }
  if (!result.ok) process.exit(1);
  log('check passed');
}
