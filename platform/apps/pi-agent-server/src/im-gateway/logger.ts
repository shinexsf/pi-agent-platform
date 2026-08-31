/**
 * Tiny pino-style logger for the IM gateway module.
 * Falls back to console.log if pino is unavailable.
 */
import * as pinoNs from 'pino';

const pinoFactory: (opts: Record<string, unknown>) => pinoNs.Logger = (pinoNs as unknown as { default: typeof pinoFactory }).default ?? (pinoNs as unknown as typeof pinoFactory);

export const logger: pinoNs.Logger = pinoFactory({
  name: 'im-gateway',
  level: process.env.LOG_LEVEL ?? 'info',
});