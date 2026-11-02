/**
 * `pi-server status` — check whether the server is alive.
 *
 * Two signals:
 *  - Process alive: `process.kill(pid, 0)` succeeds AND pidfile present.
 *  - Health check: GET /api/health responds with `{status: 'ok'}`.
 */

import process from 'node:process';
import { existsSync, statSync } from 'node:fs';
import { isRunning, readPid, resolveServerPort } from '../daemon.js';
import { log, warn } from '../logger.js';
import { pidFile } from '../paths.js';

export async function statusCommand(): Promise<void> {
  if (!isRunning()) {
    warn('not running');
    process.exit(1);
  }

  const pid = readPid();
  const port = resolveServerPort();

  // Try a health probe against /api/health. Short timeout — don't hang.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  let healthy = false;
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: ctrl.signal });
    healthy = res.ok;
    if (healthy) {
      const body = await res.json().catch(() => null);
      healthy = !!(body && typeof body === 'object' && (body as { status?: string }).status === 'ok');
    }
  } catch {
    healthy = false;
  } finally {
    clearTimeout(timer);
  }

  // Compute uptime from pidfile mtime (best effort — server doesn't expose start time).
  let uptime = 'unknown';
  if (existsSync(pidFile())) {
    try {
      const mtimeMs = statSync(pidFile()).mtimeMs;
      const seconds = Math.floor((Date.now() - mtimeMs) / 1000);
      uptime = `${seconds}s`;
    } catch { /* best effort */ }
  }

  if (healthy) {
    log(`running (pid=${pid}) port=${port} uptime=${uptime}`);
    process.exit(0);
  } else {
    warn(`running but unhealthy (pid=${pid}) port=${port} uptime=${uptime}`);
    process.exit(1);
  }
}