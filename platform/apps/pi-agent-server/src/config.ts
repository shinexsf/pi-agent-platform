/**
 * Server config: load from environment variables.
 *
 * Validates types and exits on invalid values.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childLogger } from './logger.js';

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
   * Skills bundled with the server package (change: server-builtin-skills).
   * `<dir>/<name>/SKILL.md`; undefined when the directory is absent (trimmed install) —
   * the catalogue is then empty and every configured name is reported as invalid.
   * NOT a user directory: never written to, never listed by `GET /api/config/skills`.
   */
  serverBuiltinSkillsDir: string | undefined;
  /**
   * 插件安装根 `~/.pi/server/plugins`（change: plugin-mechanism）。
   * `registry.json` 在其中；安装只能走 `pi-server plugin add`（无 HTTP 端点）。
   */
  pluginsDir: string;
  /** Global kill switch for trigger scheduling (`PI_TRIGGERS_DISABLED=1`). */
  triggersDisabled: boolean;
  /** Directory for user-uploaded image attachments, organized as <root>/<sessionId>/<sha>.<ext>.
   *  Read tool images (live session) are NOT stored here — they're owned by the source filesystem path. */
  attachmentsDir: string;
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
    databasePath,
    workerStartupTimeoutMs: parseIntStrict('WORKER_STARTUP_TIMEOUT_MS', env.WORKER_STARTUP_TIMEOUT_MS, 5000), // default 5s — pi SDK load takes ~1s (auth + models). 200ms was wishful.
    workerStopTimeoutMs: 5_000,   // invariants: SIGTERM → 5s → SIGKILL
    workspaceRoot: env.WORKSPACE_ROOT ?? process.cwd(),
    agentDir,
    mcpConfigPath: env.PI_SERVER_MCP_CONFIG ?? path.join(path.dirname(agentDir), 'server', 'mcp.json'),
    serverBuiltinSkillsDir: resolveServerBuiltinSkillsDir(env),
    pluginsDir: env.PI_SERVER_PLUGINS_DIR ?? path.join(path.dirname(agentDir), 'server', 'plugins'),
    triggersDisabled: env.PI_TRIGGERS_DISABLED === '1',
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
/**
 * Locate `skills/builtin` inside the installed server package.
 *
 * The depth differs between the two layouts, so a candidate list is used instead of one
 * hard-coded `../`:
 *   dev       apps/pi-agent-server/src/config.ts   → ../skills/builtin
 *   packaged  dist/server/config.js                → ./skills/builtin
 * `PI_SERVER_BUILTIN_SKILLS_DIR` overrides both (mirrors PI_SERVER_MCP_CONFIG).
 *
 * Returns undefined (with a warn) when nothing exists — a trimmed install must still boot;
 * the catalogue then lists nothing and configured names surface as config issues.
 */
function resolveServerBuiltinSkillsDir(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.PI_SERVER_BUILTIN_SKILLS_DIR?.trim();
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    logger.warn({ dir: explicit }, 'PI_SERVER_BUILTIN_SKILLS_DIR does not exist — builtin skill catalogue disabled');
    return undefined;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../skills/builtin'),                 // dev: apps/pi-agent-server/src → apps/pi-agent-server/skills/builtin
    path.resolve(here, 'skills/builtin'),                     // packaged: dist/server → dist/server/skills/builtin
    path.resolve(process.cwd(), 'skills/builtin'),            // cwd = server package root
    path.resolve(process.cwd(), 'apps/pi-agent-server/skills/builtin'), // cwd = monorepo platform root
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  logger.warn({ candidates }, 'builtin skill directory not found — serverBuiltinSkills will be empty');
  return undefined;
}
