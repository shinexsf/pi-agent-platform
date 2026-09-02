/**
 * `pi-server stop` — gracefully terminate the server.
 */

import process from 'node:process';
import { stopServer, isRunning, readPid } from '../daemon.js';
import { log, error } from '../logger.js';

export async function stopCommand(): Promise<void> {
  if (!isRunning()) {
    error('server not running');
    process.exit(1);
  }
  const pid = readPid();
  const ok = await stopServer();
  if (ok) {
    log(`stopped (pid=${pid})`);
    process.exit(0);
  } else {
    error('failed to stop server (process may have exited during shutdown)');
    process.exit(1);
  }
}