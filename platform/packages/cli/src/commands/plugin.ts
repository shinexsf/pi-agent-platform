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
import {
  acquireRegistryLock,
  describePluginState,
  detectFacets,
  pluginDir,
  readRegistry,
  scanPluginDirs,
  upsertEntry,
  writeRegistry,
  withRegistry,
  deletePluginDir,
} from '@pi-agent-platform/plugin-types/registry';
import { PLUGIN_API_VERSION } from '@pi-agent-platform/plugin-types';
import type { PluginRegistryFile } from '@pi-agent-platform/plugin-types';
import { error, log, warn } from '../logger.js';
import { piNpmModulesDir, pluginsDir } from '../paths.js';

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

    const entry: PluginRegistryFile['plugins'][number] = {
      id: pkg.name as string,
      version: pkg.version as string,
      dir,
      enabled: true,
      installedAt: new Date().toISOString(),
    };
    const next = upsertEntry(readRegistry(pluginsDir()), entry);
    writeRegistry(pluginsDir(), next);

    log(`registered ${pkg.name}@${pkg.version} (facets: ${facets.join(', ')})`);
    log('restart the server, or wait for the registry watcher, to load it');
  } finally {
    lock.release();
  }
}

export async function pluginListCommand(): Promise<void> {
  const dir = pluginsDir();
  const data = readRegistry(dir);
  const byDir = new Map(scanPluginDirs(dir).map((d) => [path.basename(d), d]));

  if (data.plugins.length === 0 && byDir.size === 0) {
    log('no plugins installed');
    return;
  }

  const rows: string[] = [];
  for (const entry of data.plugins) {
    byDir.delete(entry.id);
    const state = describePluginState(entry);
    const facetList = Object.entries(state.facets)
      .filter(([, on]) => on)
      .map(([name]) => name)
      .join(',');
    rows.push(
      [
        entry.id,
        entry.version,
        state.status,
        facetList || '-',
        entry.dir,
        state.reason ? `(${state.reason})` : '',
      ]
        .filter(Boolean)
        .join('  '),
    );
  }
  // 有目录但未登记 → orphan（不加载）
  for (const [name, dir] of byDir) {
    rows.push(`${name}  -  orphan  -  ${dir}  (目录存在但未登记；用 plugin add 重新登记)`);
  }

  process.stdout.write(`id  version  status  facets  dir\n${rows.join('\n')}\n`);
}

function setEnabled(id: string, enabled: boolean): void {
  const res = withRegistry(pluginsDir(), (data) => {
    const entry = data.plugins.find((p) => p.id === id);
    if (!entry) return { data, result: null };
    const next = data.plugins.map((p) => (p.id === id ? { ...p, enabled } : p));
    return { data: { version: 1, plugins: next }, result: entry };
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

export async function pluginRemoveCommand(id: string, opts: { purge?: boolean }): Promise<void> {
  const res = withRegistry(pluginsDir(), (data) => {
    const exists = data.plugins.some((p) => p.id === id);
    return { data: { version: 1, plugins: data.plugins.filter((p) => p.id !== id) }, result: exists };
  });
  if (!res.ok) {
    error(`failed to write registry: ${res.reason}`);
    process.exit(1);
  }
  if (!res.result) {
    warn(`${id} was not registered (nothing to unregister)`);
  } else {
    log(`${id} unregistered`);
  }
  if (opts.purge) {
    const dir = pluginDir(pluginsDir(), id);
    if (existsSync(dir)) {
      deletePluginDir(pluginsDir(), id);
      log(`deleted ${dir}`);
    }
  } else {
    log('install directory kept (use --purge to delete it)');
  }
  log('plugin tables (if any) are NOT dropped — only remove derived data you can recompute');
}
