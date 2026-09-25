/**
 * session-ops — shared session mutation helpers used by BOTH the HTTP routes
 * and the callServer capability control plane (capabilities/).
 *
 * Extraction rationale (callserver-control-plane, task 2.1): rename semantics
 * (worker alive → setSessionName IPC + session_info_changed event回流; dead →
 * direct DB write + heal on next load) must have a SINGLE implementation —
 * otherwise the control plane would re-implement the branch logic and the two
 * would drift. First extraction; other scattered route logic stays in place
 * until it is actually needed by both sides.
 */

import type { SessionRepo } from '../repos/session.repo.js';
import type { WorkerPool } from '../worker-pool.js';
import { childLogger } from '../logger.js';

const logger = childLogger('session-ops');

export interface SessionOpsDeps {
  sessionRepo: SessionRepo;
  workerPool: WorkerPool;
}

/**
 * Rename a session with pi-native sync (session-title-sync, design D2/D3).
 * - worker alive → `setSessionName` IPC. pi emits `session_info_changed`
 *   synchronously BEFORE the IPC response, so the DB row is already updated
 *   by the master event回流 (index.ts) when this await returns — single write path:
 *   title present ⟺ the event bridge works.
 * - worker dead or IPC failure → direct DB write; heal on next load (session-bridge)
 *   converges the pi side (DB wins).
 *
 * `title === undefined` clears the title.
 */
export async function renameSession(
  deps: SessionOpsDeps,
  id: string,
  title: string | undefined,
): Promise<void> {
  const { sessionRepo, workerPool } = deps;
  if (workerPool.has(id)) {
    try {
      await workerPool.call(id, 'setSessionName', [title ?? '']);
      return;
    } catch (err) {
      logger.warn({ err, sessionId: id }, 'setSessionName failed; falling back to direct DB write');
    }
  }
  sessionRepo.update(id, { title });
}
