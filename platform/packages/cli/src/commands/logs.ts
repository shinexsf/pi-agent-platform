/**
 * `pi-server logs [-f]` — dump or follow the server log file.
 *
 * -f / --follow: tail mode. Poll the file every 500ms for new content (simple
 * but portable; avoids extra deps like `tail`).
 */

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import process from 'node:process';
import { error } from '../logger.js';
import { logFile } from '../paths.js';

export interface LogsOptions {
  follow: boolean;
}

async function printAll(): Promise<void> {
  const file = logFile();
  if (!existsSync(file)) {
    error(`no logs found at ${file} (server may not have started yet)`);
    process.exit(1);
  }
  const content = await readFile(file, 'utf8');
  process.stdout.write(content);
}

async function follow(): Promise<void> {
  const file = logFile();
  if (!existsSync(file)) {
    error(`no logs found at ${file} (server may not have started yet)`);
    process.exit(1);
  }
  // Print existing content first.
  let lastSize = (await stat(file)).size;
  process.stdout.write(await readFile(file, 'utf8'));

  // Poll for new content.
  const poll = setInterval(async () => {
    try {
      const size = (await stat(file)).size;
      if (size > lastSize) {
        const fh = await import('node:fs').then((m) => m.promises.open(file, 'r'));
        try {
          const buf = Buffer.alloc(size - lastSize);
          await fh.read(buf, 0, buf.length, lastSize);
          process.stdout.write(buf.toString('utf8'));
        } finally {
          await fh.close();
        }
        lastSize = size;
      }
    } catch {
      // log file may have been rotated/moved; just keep polling.
    }
  }, 500);

  process.on('SIGINT', () => {
    clearInterval(poll);
    process.exit(0);
  });
  // Keep the process alive.
  await new Promise(() => { /* never resolves */ });
}

export async function logsCommand(opts: LogsOptions): Promise<void> {
  if (opts.follow) {
    await follow();
  } else {
    await printAll();
  }
}