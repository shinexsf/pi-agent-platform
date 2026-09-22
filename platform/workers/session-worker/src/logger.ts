/**
 * Worker logger — pino JSON lines to STDERR.
 *
 * stderr is piped by the master (worker-pool.ts) which re-logs every line onto
 * the server's shared timeline (adding sessionId / workerPid) and keeps a
 * bounded tail for /debug/sessions/:id. stdout is not used for logging (it is
 * inherited by the master and reserved for raw passthrough).
 *
 * sync writes — workers get SIGKILLed on timeout/eviction; buffered logs must
 * not be lost.
 */

import { pino } from 'pino';

export const logger = pino(
  {
    name: 'session-worker',
    level: process.env.LOG_LEVEL ?? 'info',
    base: { pid: process.pid },
  },
  pino.destination({ dest: 2, sync: true }),
);
