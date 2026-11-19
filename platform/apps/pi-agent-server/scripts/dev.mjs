#!/usr/bin/env node
/**
 * dev.mjs — dev-mode launcher for pi-agent-server (`pnpm dev`, runs under tsx).
 *
 * Pins the dev environment BEFORE loading the server entry:
 *   - NODE_ENV=development — enable debug routes / debug code loading
 *   - PORT               — `PI_DEV_PORT`, default 3000; matches scripts/stop-server.mjs default
 *                          (WSL boxes that also run the packaged instance use PI_DEV_PORT=3200)
 *   - strips ALL packaged-mode env (PI_SERVER_CLI, WORKER_DIST_DIR, PI_DATA_DIR,
 *     PI_ATTACHMENTS_ROOT, PI_LOG_FILE, CHANNELS_DIR, PUBLIC_DIR) — agent/CI
 *     shells may carry them (pointing at the installed pi-server), which would
 *     silently swap in the packaged worker/channels/DB and disable debug routes.
 *
 * Rationale: ambient shell env must not change dev semantics. To use another
 * port in dev, edit here (keep in sync with platform/scripts/stop-server.mjs).
 */

process.env.NODE_ENV = 'development';
process.env.PORT = process.env.PI_DEV_PORT ?? '3000';
delete process.env.PI_SERVER_CLI;
delete process.env.WORKER_DIST_DIR;
delete process.env.PI_DATA_DIR;
delete process.env.PI_ATTACHMENTS_ROOT;
delete process.env.PI_LOG_FILE;
delete process.env.CHANNELS_DIR;
delete process.env.PUBLIC_DIR;

// ── 插件目录必须 pin 到仓库内 ──────────────────────────────────────────────
// 为什么：registry 有 fs.watch。dev 与已安装实例共用一份 registry 时，你在 dev
// 里停用一个插件，正式实例的文件监听会跟着重载（反之亦然）。
// 用户插件目录与 bundled 目录都指向仓库内路径，互不干扰。
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const platformRoot = path.resolve(serverRoot, '..', '..');
const devPluginsDir = path.join(platformRoot, '.dev-data', 'plugins');
mkdirSync(devPluginsDir, { recursive: true });

process.env.PI_SERVER_PLUGINS_DIR = devPluginsDir;
process.env.PI_PLUGIN_REGISTRY = path.join(devPluginsDir, 'registry.json');
// bundled 插件就是仓库里的 platform/plugins（目录存在即生效，不需要 registry）
process.env.PI_SERVER_BUNDLED_PLUGINS_DIR = path.join(platformRoot, 'plugins');

// 首次 dev 启动：把已安装实例的 registry 作为**初始种子**抄过来（只抄一次）。
// 目的：不打断开发者已有的插件集合，又不让两边继续共用同一个文件。
const seedSource = path.join(
  process.env.HOME ?? '',
  '.pi',
  'server',
  'plugins',
  'registry.json',
);
if (!existsSync(process.env.PI_PLUGIN_REGISTRY) && existsSync(seedSource)) {
  try {
    writeFileSync(process.env.PI_PLUGIN_REGISTRY, readFileSync(seedSource));
    console.log(`[dev] seeded plugin registry from ${seedSource} → ${process.env.PI_PLUGIN_REGISTRY}`);
  } catch (err) {
    console.warn(`[dev] failed to seed plugin registry: ${String(err)}`);
  }
}

await import('../src/index.ts');
