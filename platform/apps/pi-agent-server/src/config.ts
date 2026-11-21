/**
 * Server config: load from environment variables.
 *
 * Validates types and exits on invalid values.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childLogger } from '@pi-agent-platform/core';

const logger = childLogger('config');

export interface ServerConfig {
  port: number;
  nodeEnv: 'development' | 'production' | 'test';
  isDev: boolean;
  /** Idle timeout for placeholder workers (no DB row). Active sessions never auto-timeout —
   *  they're killed explicitly (IDE tab close, future Web manual management). */
  placeholderTimeoutMs: number;
  /** Max concurrent worker processes. LRU-evicts placeholder workers when full. */
  maxWorkers: number;
  /** 运行版本（打包态由 CLI 经 `PI_SERVER_VERSION` 注入；dev 态回落到 workspace 版本）。 */
  version: string;
  /** 动作 HTTP 面（`POST /api/p/<id>/<path>`）的全局开关，默认关。
   *  关闭时动作路由一律 404；打开只是让它们可达，鉴权另说（后置）。 */
  actionHttpEnabled: boolean;
  databasePath: string;
  workerStartupTimeoutMs: number;
  workerStopTimeoutMs: number;
  workspaceRoot: string;
  agentDir: string;
  /**
   * Platform MCP catalog `~/.pi/server/mcp.json` (change: platform-mcp-catalog).
   * Server definitions live ONLY here — the DB stores just the names an agent selected.
   */
  mcpConfigPath: string;
  /**
   * 插件安装根 `~/.pi/server/plugins`（change: plugin-mechanism）。
   * `registry.json` 在其中；安装只能走 `pi-server plugin add`（无 HTTP 端点）。
   */
  pluginsDir: string;
  /**
   * 随包插件目录（bundled）：目录存在即生效，不进 registry。
   * 打包态 = `<安装根>/dist/server/plugins`；dev 态 = 仓库 `platform/plugins`。
   * `undefined` = 这个进程没有随包插件（内嵌场景）。
   */
  bundledPluginsDir: string | undefined;
  /** Directory for user-uploaded image attachments, organized as <root>/<sessionId>/<sha>.<ext>.
   *  Read tool images (live session) are NOT stored here — they're owned by the source filesystem path. */
  attachmentsDir: string;
}

/**
 * 定位随包插件目录。
 *
 * 不能只写死一个相对层级：这个文件在 dev 态被 tsx 从 `src/` 跑、打包态被 node 从
 * `dist/server/` 跑，差一层就静默找不到（然后"随包插件全没了"却没有任何报错）。
 * 所以按**存在性**挑第一个命中；都不存在就返回 undefined（内嵌场景本来就没有随包插件）。
 */
function resolveBundledPluginsDir(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env.PI_SERVER_BUNDLED_PLUGINS_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'plugins'),            // 打包态：dist/server/plugins
    path.join(here, '..', '..', 'plugins'), // dev 态：apps/pi-agent-server/src → platform/plugins
    path.join(here, '..', 'plugins'),       // 其它布局兜底
  ];
  return candidates.find((dir) => existsSync(dir));
}

function parseIntStrict(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    logger.error({ name, raw }, 'invalid config value: must be a positive integer');
    process.exit(1);
  }
  if (n <= 0) {
    logger.error({ name, raw }, 'invalid config value: must be > 0');
    process.exit(1);
  }
  return n;
}

function parseNodeEnv(raw: string | undefined): ServerConfig['nodeEnv'] {
  if (raw === 'production' || raw === 'test') return raw;
  return 'development';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const agentDir = env.PI_AGENT_DIR ?? defaultAgentDir();

  // Packaged mode (started by `pi-server` CLI): use absolute paths injected via env.
  // Dev mode: fall through to original env vars / defaults.
  const isPackaged = env.PI_SERVER_CLI === '1';
  const databasePath = (isPackaged && env.PI_DATA_DIR)
    ? path.join(env.PI_DATA_DIR, 'data.db')
    : (env.DATABASE_PATH ?? './data.db');
  const attachmentsDir = (isPackaged && env.PI_ATTACHMENTS_ROOT)
    ? env.PI_ATTACHMENTS_ROOT
    : (env.PI_AGENT_ATTACHMENTS_ROOT ?? defaultAttachmentsDir());

  return {
    port: parseIntStrict('PORT', env.PORT, 3000),
    nodeEnv,
    isDev: nodeEnv !== 'production',
    placeholderTimeoutMs: parseIntStrict(
      'PLACEHOLDER_TIMEOUT_MINUTES',
      env.PLACEHOLDER_TIMEOUT_MINUTES,
      5, // default 5 minutes for placeholder (no DB row)
    ) * 60_000,
    maxWorkers: parseIntStrict('MAX_WORKERS', env.MAX_WORKERS, 20),
    version: env.PI_SERVER_VERSION ?? '0.1.0-dev',
    // 默认关闭：动作一旦被声明就自动可路由是"漏了会静默坏"，所以这一面默认关。
    actionHttpEnabled: env.PI_SERVER_ACTION_HTTP === '1' || env.PI_SERVER_ACTION_HTTP === 'true',
    databasePath,
    workerStartupTimeoutMs: parseIntStrict('WORKER_STARTUP_TIMEOUT_MS', env.WORKER_STARTUP_TIMEOUT_MS, 5000), // default 5s — pi SDK load takes ~1s (auth + models). 200ms was wishful.
    workerStopTimeoutMs: 5_000,   // invariants: SIGTERM → 5s → SIGKILL
    workspaceRoot: env.WORKSPACE_ROOT ?? process.cwd(),
    agentDir,
    mcpConfigPath: env.PI_SERVER_MCP_CONFIG ?? path.join(path.dirname(agentDir), 'server', 'mcp.json'),
    pluginsDir: env.PI_SERVER_PLUGINS_DIR ?? path.join(path.dirname(agentDir), 'server', 'plugins'),
    bundledPluginsDir: resolveBundledPluginsDir(env),
    attachmentsDir,
  };
}

function defaultAttachmentsDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.env.HOMEPATH ?? '.';
  const sep = home.includes('\\') ? '\\' : '/';
  return `${home}${sep}.pi-agent-server${sep}attachments`;
}

function defaultAgentDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.env.HOMEPATH ?? '.';
  const sep = home.includes('\\') ? '\\' : '/';
  return `${home}${sep}.pi${sep}agent`;
}

export const config = loadConfig();
