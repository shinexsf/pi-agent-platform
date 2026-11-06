/**
 * `webhook` source — dumb HTTP endpoint, no time semantics.
 *
 * No `computeNextAt`: webhook triggers never participate in the scheduler scan.
 * The HTTP entry point is the platform's FIXED route `POST /api/hooks/:triggerId`
 * (routes/hooks.ts) — sources cannot register routes (Hono freezes its table).
 */

import { randomBytes } from 'node:crypto';
import type { SourceSpec } from '../sources.js';

export const MIN_SECRET_LENGTH = 16;

/** Server-side secret generation (shown to the user exactly once). */
export function generateWebhookSecret(): string {
  return randomBytes(24).toString('base64url');
}

export const webhookSource: SourceSpec = {
  source: 'webhook',
  label: 'Webhook',
  description: '外部系统 POST 到 /api/hooks/:triggerId，Bearer 密钥鉴权',
  httpEntry: true,
  hasSecret: true,
  validateConfig(config) {
    const secret = typeof config.secret === 'string' ? config.secret : '';
    if (secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`webhook: 密钥长度至少 ${MIN_SECRET_LENGTH} 位`);
    }
    return { secret };
  },
};
