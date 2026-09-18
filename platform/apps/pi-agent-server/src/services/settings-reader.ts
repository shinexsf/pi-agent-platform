/**
 * Synchronous settings reader for use in session-bridge and other sync contexts.
 * Reads server-specific config from ~/.pi/server/config.json.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface GlobalSettings {
  defaultExtensions?: string[];
  defaultSkills?: string[];
  defaultPrompts?: string[];
  defaultBuiltinTools?: string[];
  [key: string]: unknown;
}

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
