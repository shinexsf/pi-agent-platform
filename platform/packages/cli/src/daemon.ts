/**
 * Daemon management for pi-server.
 *
 * Spawns the server as a detached child process and tracks it via pidfile.
 * Cross-platform kill: POSIX uses SIGTERM→SIGKILL, Windows uses `taskkill /F`.
 *
 * The CLI injects 7 environment variables into the server child process to
 * enable packaged-mode path resolution (see proposal/design for details):
 *   - PI_SERVER_CLI=1              (marker — server checks this)
 *   - NODE_ENV=production          (suppresses debug routes)
 *   - WORKER_DIST_DIR              (where worker dist lives)
 *   - PI_DATA_DIR                  (sqlite dir)
 *   - PI_ATTACHMENTS_ROOT          (user uploads dir)
 *   - CHANNELS_DIR                 (bundled channels dir)
 *   - PUBLIC_DIR                   (bundled SPA dir)
 */

import { spawn, exec } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync, openSync, cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  channelsDir,
  cliRoot,
  dataRoot,
  logFile,
  pidFile,
  publicDir,
  serverEntry,
  workerEntry,
} from './paths.js';
import { log } from './logger.js';

/** Returns true if `pid` is a live process. `process.kill(pid, 0)` is the cross-platform probe. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = exists but no permission (still alive).
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/** Read pid from pidfile, or null if missing/malformed. */
export function readPid(): number | null {
  const file = pidFile();
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, 'utf8').trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/** True if the server is currently running (pidfile + process alive). */
export function isRunning(): boolean {
  const pid = readPid();
  if (pid === null) return false;
  if (!isProcessAlive(pid)) {
    // Stale pidfile — clean it up so subsequent start works without manual intervention.
    try { unlinkSync(pidFile()); } catch { /* best effort */ }
    return false;
  }
  return true;
}

export interface StartResult {
  pid: number;
}

/**
 * Copy the bundled better-sqlite3 (with native binary) into the global
 * node_modules directory so the server can `require('better-sqlite3')`.
 * Idempotent: skips if already present.
 *
 * Why: pi-server does NOT declare better-sqlite3 as a runtime dependency
 * (because its `install` hook triggers node-gyp on systems without Visual
 * Studio / prebuild network access). We bundle the prebuilt binary from the
 * dev workspace and stage it into the global tree at start time.
 */
export function ensureBetterSqlite3(): void {
  const vendorDir = path.join(cliRoot(), 'dist', 'vendor', 'better-sqlite3');
  if (!existsSync(vendorDir)) {
    log('warn: bundled better-sqlite3 vendor not found — server may fail to load SQLite if prebuild-install was unreachable');
    return;
  }
  const globalNm = path.dirname(cliRoot());
  const target = path.join(globalNm, 'better-sqlite3');
  const nativeFile = path.join(target, 'build', 'Release', 'better_sqlite3.node');
  if (existsSync(nativeFile)) return; // already staged

  mkdirSync(target, { recursive: true });
  cpSync(vendorDir, target, { recursive: true });
  log(`staged better-sqlite3 native binary into ${target}`);
}

/**
 * Spawn the server as a detached child. Returns immediately.
 * - Server stdout/stderr → logFile (append)
 * - Process is detached (POSIX: setsid + unref; Windows: windowsHide)
 * - pidfile is written before returning
 */
export function startServer(): StartResult {
  const entry = serverEntry();
  if (!existsSync(entry)) {
    throw new Error(
      `server entry not found at ${entry}\n` +
      `The package may be corrupted. Try reinstalling: npm uninstall -g pi-server && npm install -g ./pi-server-0.0.1-alpha.tgz`
    );
  }

  ensureBetterSqlite3();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Always override PORT — the user's shell may have PORT set to a value
    // occupied by another process on the same machine. Server defaults to 3000.
    // Users who want a different port should edit config.env or use --port (post-MVP).
    PORT: '3000',
    NODE_ENV: 'production',
    PI_SERVER_CLI: '1',
    WORKER_DIST_DIR: path.dirname(workerEntry()),
    PI_DATA_DIR: path.join(dataRoot(), 'data'),
    PI_ATTACHMENTS_ROOT: path.join(dataRoot(), 'attachments'),
    CHANNELS_DIR: channelsDir(),
    PUBLIC_DIR: publicDir(),
  };

  // Open log file for append (create if missing). Both stdout and stderr go here.
  const logFd = openSync(logFile(), 'a');

  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
    windowsHide: true,
  });

  // POSIX: detach from controlling terminal. Windows: detached flag is enough.
  child.unref();

  const pid = child.pid;
  if (typeof pid !== 'number') {
    throw new Error('failed to spawn server: no pid returned');
  }

  writeFileSync(pidFile(), String(pid), 'utf8');
  return { pid };
}

/**
 * Stop the server. Returns true if a process was signalled, false if nothing was running.
 * - POSIX: SIGTERM, wait up to 5s, then SIGKILL.
 * - Windows: `taskkill /F /PID <pid>` (no SIGTERM equivalent).
 */
export async function stopServer(timeoutMs = 5_000): Promise<boolean> {
  const pid = readPid();
  if (pid === null) return false;

  if (!isProcessAlive(pid)) {
    try { unlinkSync(pidFile()); } catch { /* best effort */ }
    return false;
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      exec(`taskkill /F /PID ${pid}`, () => resolve());
    });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* may already be exiting */ }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && isProcessAlive(pid)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (isProcessAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* give up */ }
    }
  }

  try { unlinkSync(pidFile()); } catch { /* best effort */ }
  return true;
}