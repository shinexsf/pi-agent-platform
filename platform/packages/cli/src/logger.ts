/**
 * Tiny CLI logger. Writes to stderr so output is greppable separately from
 * command results on stdout. Format: `[pi-server] <level> <message>`.
 */

function emit(level: string, msg: string): void {
  process.stderr.write(`[pi-server] ${level} ${msg}\n`);
}

export function log(msg: string): void {
  emit('info', msg);
}

export function warn(msg: string): void {
  emit('warn', msg);
}

export function error(msg: string): void {
  emit('error', msg);
}