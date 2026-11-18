/**
 * logger.ts — unified structured logger for the whole server process.
 *
 * All runtime logs are JSON lines (`{time, level, name, msg, ...fields}`) on ONE
 * timeline, written to two destinations (fully synchronous — crash-safe):
 *   - stdout      — visible in the dev terminal
 *   - log file    — FIXED filename, classic rotation:
 *       active:   dev-server.log (dev) / server.log (prod, via $PI_LOG_FILE)
 *       archive:  <name>.<timestamp>.log on roll (keeps the newest $PI_LOG_KEEP)
 *       roll by   $PI_LOG_MAX_SIZE bytes (default 10MB)
 *       dev path: <this-package>/logs/  ·  prod: $PI_LOG_FILE (injected by pi-server CLI)
 *
 * Conventions (agent-testing skill「看日志」):
 *   - Runtime events → logger.info / warn / error with structured fields
 *     (sessionId etc. as FIELDS, not interpolated into msg)
 *   - Diagnostics    → logger.debug (only visible with LOG_LEVEL=debug)
 *   - console.* is bridged into the logger so even third-party SDK output lands
 *     on the same timeline; a tiny denylist drops known heartbeat noise.
 *   - The startup banner is the only raw-stdout citizen (process.stdout.write).
 *
 * Other logger entry points (all end up on this timeline):
 *   - im-gateway/logger.ts       — child logger ({ name: 'im-gateway' }) of this instance
 *   - channels/shared/logger.js  — uses globalThis.__piPlatformLogger (set below) when
 *                                  loaded in-process; own pino only as standalone fallback
 *   - workers/session-worker     — separate process: pino → stderr, re-logged line-by-line
 *                                  by worker-pool.ts (adds sessionId / workerPid)
 *
 * Log level: $LOG_LEVEL (default 'info'). Set 'debug' to see diagnostics.
 */

import * as pinoNs from 'pino';
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pinoFactory: typeof pinoNs.pino = (pinoNs as unknown as { default: typeof pinoNs.pino }).default ?? pinoNs.pino;

const level = process.env.LOG_LEVEL ?? 'info';

/** Where the log file lives (see header). Fixed filename — always the ACTIVE log. */
export const serverLogFile: string = process.env.PI_LOG_FILE
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../logs/dev-server.log');

const maxBytes = Number.parseInt(process.env.PI_LOG_MAX_SIZE ?? '', 10) || 10 * 1024 * 1024;
const keepArchives = Number.parseInt(process.env.PI_LOG_KEEP ?? '', 10) || 5;

/**
 * Minimal rolling file sink (pino DestinationStream).
 *
 * Classic rotation semantics: the active file keeps a FIXED name; on roll the
 * current file is renamed to an archive (`<name>.<timestamp>.log`) and a fresh
 * same-named file is created — so `tail -f` / `pi-server logs -f` can keep
 * following one path forever. Single writer (this process), sync writes.
 */
class RollingFileSink {
  private fd: number | null = null;
  private size = 0;

  constructor(
    private readonly file: string,
    private readonly maxBytes: number,
    private readonly keep: number,
  ) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.open();
  }

  write(msg: string): void {
    if (this.fd === null) return;
    const buf = Buffer.from(msg);
    writeSync(this.fd, buf);
    this.size += buf.length;
    if (this.size >= this.maxBytes) this.roll();
  }

  private open(): void {
    this.fd = openSync(this.file, 'a');
    this.size = fstatSync(this.fd).size;
  }

  private roll(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    const dir = path.dirname(this.file);
    const base = path.basename(this.file).replace(/\.log$/, '');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      renameSync(this.file, path.join(dir, `${base}.${ts}.log`));
    } catch {
      // rename failed (rare) — keep appending to the same file rather than losing logs
    }
    this.prune();
    this.open();
  }

  /** Keep only the newest `keep` archives (active file untouched). */
  private prune(): void {
    const dir = path.dirname(this.file);
    const base = path.basename(this.file).replace(/\.log$/, '');
    const re = new RegExp(`^${base}\\.(.+)\\.log$`);
    const archives: string[] = [];
    try {
      for (const f of readdirSync(dir)) {
        if (re.test(f)) archives.push(f);
      }
    } catch {
      return;
    }
    // Timestamped names sort lexicographically = chronologically.
    archives.sort();
    while (archives.length > this.keep) {
      const oldest = archives.shift();
      if (oldest) {
        try {
          unlinkSync(path.join(dir, oldest));
        } catch {
          /* best effort */
        }
      }
    }
  }
}

const sink = new RollingFileSink(serverLogFile, maxBytes, keepArchives);

export const logger: pinoNs.Logger = pinoFactory(
  { name: 'server', level },
  pinoFactory.multistream([
    { stream: process.stdout }, // dev terminal visibility
    { stream: sink },           // rotating log file
  ]),
);

/** Named child logger for a module, e.g. childLogger('session-info'). */
export function childLogger(name: string): pinoNs.Logger {
  return logger.child({ name });
}

// Register for in-process consumers (channels/shared/logger.js) so channel logs
// share this process's transport/timeline instead of creating their own sink.
(globalThis as Record<string, unknown>).__piPlatformLogger = logger;

// ── console bridge ───────────────────────────────────────────────────────────
// console.* (ours or third-party SDKs') is routed through the logger so every
// line gets time/level and lands on the same timeline + log file. Known
// third-party heartbeat noise is dropped here (previously a monkey-patch in
// index.ts filtered only console.log).

const NOISE_PATTERNS = [/心跳校验/, /\[CLIENT\]/];

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

function bridge(levelName: 'info' | 'warn' | 'error' | 'debug'): (...args: unknown[]) => void {
  return (...args: unknown[]): void => {
    const msg = formatArgs(args);
    if (NOISE_PATTERNS.some((re) => re.test(msg))) return;
    logger[levelName]({ src: 'console' }, msg);
  };
}

console.log = bridge('info');
console.info = bridge('info');
console.warn = bridge('warn');
console.error = bridge('error');
console.debug = bridge('debug');
