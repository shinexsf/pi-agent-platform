#!/usr/bin/env node
/**
 * CLI entry point — registered by `bin/pi-server.js` (the npm shim).
 */

import { Command } from 'commander';
import { startCommand } from './commands/start.js';
import { stopCommand } from './commands/stop.js';
import { statusCommand } from './commands/status.js';
import { logsCommand } from './commands/logs.js';

const program = new Command();

program
  .name('pi-server')
  .description('CLI for managing the pi-agent-platform server')
  .version('0.0.1-alpha');

program
  .command('start')
  .description('start the server in the background (idempotent: errors if already running)')
  .action(async () => {
    await startCommand();
  });

program
  .command('stop')
  .description('gracefully stop the running server')
  .action(async () => {
    await stopCommand();
  });

program
  .command('status')
  .description('check whether the server is running and healthy')
  .action(async () => {
    await statusCommand();
  });

program
  .command('logs')
  .description('print server logs (use -f to follow)')
  .option('-f, --follow', 'follow new log output (Ctrl+C to stop)')
  .action(async (opts: { follow?: boolean }) => {
    await logsCommand({ follow: !!opts.follow });
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`[pi-server] error: ${err?.stack ?? err}\n`);
  process.exit(1);
});