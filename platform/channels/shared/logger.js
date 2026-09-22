/**
 * Channel-shared logger (plain JS — not TS, to avoid `pnpm -r build` walking
 * into workspace-internal types).
 *
 * When a channel package is loaded inside the server process, the unified
 * server logger (`apps/pi-agent-server/src/logger.ts`) has registered itself on
 * `globalThis.__piPlatformLogger` — we use a named child of it so channel logs
 * share the server's timeline + rotating log file.
 *
 * The standalone pino below is only a fallback for running a channel package
 * outside the server (ad-hoc tests/tools).
 */

import pino from 'pino';

const hostLogger = globalThis.__piPlatformLogger;

const logger = hostLogger
  ? hostLogger.child({ name: 'im-gateway-channel' })
  : pino({
      name: 'im-gateway-channel',
      level: process.env.LOG_LEVEL ?? 'info',
    });

export { logger };
export default logger;
