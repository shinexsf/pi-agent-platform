/**
 * Path resolution for pi-server CLI.
 *
 * Two distinct root paths:
 * - `cliRoot()`: where the npm package is installed (immutable per install).
 *   - POSIX: `/usr/local/lib/node_modules/pi-server/`
 *   - Windows: `%APPDATA%\npm\node_modules\pi-server\`
 * - `dataRoot()`: where user data lives (mutable, survives upgrades).
 *   - POSIX: `$HOME/.pi/server/`
 *   - Windows: `%USERPROFILE%\.pi\server\`
 *
 * Resolves the CLI root by walking up from this source file location at runtime,
 * so it works regardless of where npm dropped the package.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * CLI package root. Walks up from this compiled file until it finds `package.json`.
 * - In dev/test: `<repo>/platform/packages/cli/`
 * - Installed: `<global>/node_modules/pi-server/` (or similar npm layout)
 */
export function cliRoot(): string {
  // dist/paths.js -> ../  (sibling of dist is the package root)
  return path.resolve(__dirname, '..');
}

/**
 * User data root. Immutable path: `$HOME/.pi/server` (or `%USERPROFILE%\.pi\server`).
 */
export function dataRoot(): string {
  return path.join(homedir(), '.pi', 'server');
}

/** Path to the compiled server entry that the CLI will spawn. */
export function serverEntry(): string {
  return path.join(cliRoot(), 'dist', 'server', 'index.js');
}

/** Path to the compiled worker entry (informational; server spawns it via env var). */
export function workerEntry(): string {
  return path.join(cliRoot(), 'dist', 'worker', 'index.js');
}

/** Path to the bundled IM channels directory. */
export function channelsDir(): string {
  return path.join(cliRoot(), 'dist', 'server', 'channels');
}

/** Path to the bundled SPA public directory. */
export function publicDir(): string {
  return path.join(cliRoot(), 'dist', 'server', 'public');
}

/** Where the daemon PID is persisted. */
export function pidFile(): string {
  return path.join(dataRoot(), 'run', 'server.pid');
}

/** Where server stdout/stderr is written. */
export function logFile(): string {
  return path.join(dataRoot(), 'logs', 'server.log');
}

/** Sub-directories under dataRoot() that must exist before start. */
export function dataSubdirs(): string[] {
  return [
    path.join(dataRoot(), 'data'),
    path.join(dataRoot(), 'attachments'),
    path.join(dataRoot(), 'logs'),
    path.join(dataRoot(), 'run'),
  ];
}