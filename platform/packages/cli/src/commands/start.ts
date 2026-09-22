/**
 * `pi-server start` — spawn the server as a detached background process.
 */

import { mkdir } from 'node:fs/promises';
import process from 'node:process';
import { startServer, isRunning, readPid } from '../daemon.js';
import { log, error } from '../logger.js';
import { dataSubdirs } from '../paths.js';

export async function startCommand(): Promise<void> {
  if (isRunning()) {
    error(`server already running (pid=${readPid()}) — use 'pi-server status' or 'stop' first`);
    process.exit(1);
  }

  for (const dir of dataSubdirs()) {
    await mkdir(dir, { recursive: true });
  }

  const { pid } = startServer();
  log(`started pid=${pid}`);
  log(`logs: ${process.platform === 'win32' ? '%USERPROFILE%\\.pi\\server\\logs\\server.log' : '~/.pi/server/logs/server.log'} (fixed name — active log; archives: server.<timestamp>.log)`);
  process.exit(0);
}