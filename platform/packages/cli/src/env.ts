/**
 * User config management for pi-server.
 *
 * Stores simple KEY=VALUE config in `<dataRoot>/config.env`. Used for optional
 * user overrides like custom port or PI model overrides. The CLI does not
 * require this file to exist; everything has sensible defaults.
 *
 * MVP scope: read + write helpers only. No command wiring yet (post-MVP).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataRoot } from './paths.js';

/** Path to the user config file. */
export function configFile(): string {
  return path.join(dataRoot(), 'config.env');
}

/**
 * Read user config as a Record. Missing file → empty object.
 * Lines starting with `#` are ignored. Empty lines are skipped.
 * Format: `KEY=VALUE` (no quoting/escaping in MVP).
 */
export function getUserConfig(): Record<string, string> {
  const file = configFile();
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, 'utf8');
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    result[key] = value;
  }
  return result;
}

/**
 * Set a single KEY=VALUE in the user config. Creates the file if missing.
 * Preserves existing entries not overwritten.
 */
export function setUserConfig(key: string, value: string): void {
  const current = getUserConfig();
  current[key] = value;
  const file = configFile();
  const lines = Object.entries(current).map(([k, v]) => `${k}=${v}`);
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}