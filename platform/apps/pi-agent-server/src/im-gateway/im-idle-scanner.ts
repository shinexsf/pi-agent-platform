/**
 * im-idle-scanner — periodically scans session-channel-map and kills workers
 * whose `lastActiveAt` exceeds the IM idle timeout (default 30 minutes).
 *
 * Unlike web/IDE sessions (which are governed by placeholder timeout + LRU eviction),
 * IM sessions can be "abandoned" for hours after the user walks away. Killing the
 * worker (but NOT the session row) lets us reclaim worker slots while preserving
 * history. The next message triggers respawn via `spawnAndCreate(existingSessionPath)`.
 *
 * sessions table is NOT touched — only the worker process is killed.
 */

import type { WorkerPool } from '../worker-pool.js';
import { iterateSessionMeta } from './session-channel-map.js';
import { logger } from './logger.js';

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_SCAN_INTERVAL_MS = 60 * 1000;

export interface IdleScannerHandle {
  stop(): void;
}

/** Start the scanner. Returns a handle for graceful shutdown. */
export function startImIdleScanner(
  workerPool: WorkerPool,
  opts: { idleMs?: number; scanIntervalMs?: number } = {},
): IdleScannerHandle {
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const intervalMs = opts.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;

  const handle = setInterval(() => {
    try {
      const now = Date.now();
      let killed = 0;
      for (const [sessionId, meta] of iterateSessionMeta()) {
        if (now - meta.lastActiveAt < idleMs) continue;
        if (!workerPool.has(sessionId)) continue;
        // kill asynchronously, don't block the scan loop
        workerPool.kill(sessionId, 'im-idle-timeout').catch((err) => {
          logger.warn({ err: String(err), sessionId }, 'im-idle-timeout kill failed');
        });
        killed++;
      }
      if (killed > 0) {
        logger.info({ killed, idleMs }, 'im-idle-scanner killed idle workers');
      }
    } catch (err) {
      logger.error({ err: String(err) }, 'im-idle-scanner tick failed');
    }
  }, intervalMs);
  // Don't block process exit on this handle.
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as { unref(): unknown }).unref();
  }

  logger.info({ idleMs, intervalMs }, 'im-idle-scanner started');

  return {
    stop() {
      clearInterval(handle);
      logger.info('im-idle-scanner stopped');
    },
  };
}