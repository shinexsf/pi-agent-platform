/**
 * Channel-shared pino logger (plain JS — not TS, to avoid `pnpm -r build`
 * walking into workspace-internal types).
 *
 * Mirror of `apps/pi-agent-server/src/im-gateway/logger.ts`. Exists here so
 * channels don't need to import from `@pi-agent-platform/server/...` (which is
 * a workspace-internal package and does not exist in the packaged npm tarball).
 *
 * If the upstream logger changes (level, target, etc.), copy the change here.
 */

import pino from 'pino';

const logger = pino({
  name: 'im-gateway-channel',
  level: process.env.LOG_LEVEL ?? 'info',
});

export { logger };
export default logger;
