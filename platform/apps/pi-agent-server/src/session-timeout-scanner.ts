/**
 * Periodically kill **placeholder** workers (no DB row) that haven't received
 * their first user message within `placeholderTimeoutMs`.
 *
 * Active sessions (has DB row) are NEVER auto-killed — they're terminated
 * explicitly when the user closes the IDE tab or via a future Web management API.
 *
 * The DB row itself is never modified by the scanner; worker pool is the source
 * of truth for whether a session is alive.
 */

import type { WorkerPool } from './worker-pool.js';

export function startTimeoutScanner(
  workerPool: WorkerPool,
  placeholderTimeoutMs: number,
): { stop: () => void } {
  const SCAN_INTERVAL_MS = 60_000;

  const timer = setInterval(async () => {
    try {
      const now = Date.now();
      let killed = 0;
      // Iterate over a snapshot so we can mutate the underlying map (kill removes entries).
      const snapshot = workerPool.list();
      for (const entry of snapshot) {
        if (!entry.hasRow && (now - entry.spawnTime) > placeholderTimeoutMs) {
          await workerPool.kill(entry.sessionId, 'placeholder-timeout');
          killed++;
        }
      }
      if (killed > 0) {
        process.stderr.write(`[server] killed ${killed} placeholder worker(s) (timeout=${placeholderTimeoutMs}ms)\n`);
      }
    } catch (err) {
      process.stderr.write(`[server] timeout scanner error: ${(err as Error).message}\n`);
    }
  }, SCAN_INTERVAL_MS);

  return {
    stop: () => clearInterval(timer),
  };
}