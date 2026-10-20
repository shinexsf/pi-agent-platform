/**
 * Synchronous settings reader for use in services/session and other sync contexts.
 * Reads server-specific config from ~/.pi/server/config.json.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface GlobalSettings {
  defaultExtensions?: string[];
  defaultSkills?: string[];
  defaultPrompts?: string[];
  defaultBuiltinTools?: string[];
  /** Global default for AgentConfig.serverBuiltinTools (server-side custom tools:
   *  sendFileToUser / callServer). undefined = built-in default ['sendFileToUser']. */
  defaultServerBuiltinTools?: string[];
  [key: string]: unknown;
}

/**
 * Platform default for `AgentConfig.builtinTools` — used only when the user has NOT configured
 * `defaultBuiltinTools` in `~/.pi/server/config.json`.
 *
 * One list drives BOTH: (a) which pi builtin tools are activated, and (b) which pi builtin
 * extensions get loaded (`codemode` / `tool_search` are extension-provided tools — naming them
 * here loads `builtin:<ext>` in the worker). `mcp` is deliberately absent: loading it connects
 * every server in `mcp.json` on session start, and it may be replaced by `pi-mcp-adapter` —
 * opt in per agent instead.
 */
export const DEFAULT_BUILTIN_TOOLS: readonly string[] = [
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'find',
  'ls',
  'powershell',
  'codemode',
  'tool_search',
];

function serverConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.env.HOMEPATH ?? '.';
  const sep = home.includes('\\') ? '\\' : '/';
  return `${home}${sep}.pi${sep}server${sep}config.json`;
}

let cachedSettings: GlobalSettings | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5000; // 5 seconds

/**
 * Read server config synchronously (with short-lived cache).
 * Returns null if file doesn't exist or can't be parsed.
 */
export function readSettings(): GlobalSettings | null {
  const now = Date.now();
  if (cachedSettings !== null && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedSettings;
  }

  try {
    const configPath = serverConfigPath();
    if (!existsSync(configPath)) {
      cachedSettings = null;
      cacheTimestamp = now;
      return null;
    }
    const content = readFileSync(configPath, 'utf-8');
    cachedSettings = JSON.parse(content) as GlobalSettings;
    cacheTimestamp = now;
    return cachedSettings;
  } catch {
    cachedSettings = null;
    cacheTimestamp = now;
    return null;
  }
}
