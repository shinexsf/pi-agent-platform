/**
 * `pi-server status` — check whether the server is alive.
 *
 * Two signals:
 *  - Process alive: `process.kill(pid, 0)` succeeds AND pidfile present.
 *  - Health check: GET /api/health responds with `{status: 'ok'}`.
 */

import process from 'node:process';
import { existsSync, statSync } from 'node:fs';
import { isRunning, readPid } from '../daemon.js';
import { log, warn } from '../logger.js';
import { pidFile } from '../paths.js';

function readPortFromEntry(): number {
  // The CLI daemon.ts hardcodes PORT='9006' when spawning the server (see
  // daemon.ts:startServer) — it deliberately ignores shell PORT to avoid
  // colliding with other processes on the same machine. So we hardcode 9006
  // here too. (Post-MVP: parse from server log or expose /api/server/info.)
  return 9006;
}

export async function statusCommand(): Promise<void> {
  if (!isRunning()) {
    warn('not running');
    process.exit(1);
  }

  const pid = readPid();
  const port = readPortFromEntry();

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