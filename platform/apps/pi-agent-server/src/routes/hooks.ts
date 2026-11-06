/**
 * Webhook adapter — the platform's FIXED HTTP entry for `source='webhook'`
 * (change: trigger-scheduling).
 *
 * Why a fixed route: Hono freezes its route table after the first request
 * (`#addRoute` throws when `!isFresh`), so a source cannot register its own
 * endpoint at runtime. Sources therefore describe config/time only.
 *
 * This layer ONLY does HTTP work: bearer check bound to the path's triggerId,
 * idempotency header, body cap. It then builds the trigger event FROM THE ROW —
 * nothing in the body can influence `target`.
 */

import { Hono } from 'hono';
import type { TriggerRuntime } from '../services/trigger/runtime.js';
import { childLogger } from '../logger.js';

const logger = childLogger('trigger-hooks');

/** Bodies above this are truncated and the original byte count is recorded. */
const MAX_BODY_BYTES = 64 * 1024;

export function createHooksRouter(rt: TriggerRuntime) {
  const router = new Hono();
  const { repo, dispatcher } = rt;

  router.post('/:triggerId', async (c) => {
    const triggerId = c.req.param('triggerId');
    const trigger = repo.get(triggerId);
    // Unknown id and wrong source look identical from outside (no enumeration).
    if (!trigger || trigger.source !== 'webhook') {
      return c.json({ error: 'not found' }, 404);
    }
    const expected = typeof trigger.config.secret === 'string' ? trigger.config.secret : '';
    const header = c.req.header('authorization') ?? '';
    const provided = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (!expected || provided.length === 0 || !timingSafeEqual(provided, expected)) {
      logger.warn({ triggerId }, 'webhook call rejected (bad secret)');
      return c.json({ error: 'unauthorized' }, 401);
    }

    // Body: raw text (kept verbatim as `<data>`), capped.
    const raw = await c.req.text();
    const bytes = Buffer.byteLength(raw);
    let payload: unknown;
    let truncated = false;
    if (bytes > MAX_BODY_BYTES) {
      truncated = true;
      const cut = Buffer.from(raw, 'utf-8').subarray(0, MAX_BODY_BYTES).toString('utf-8');
      payload = safeParse(cut) ?? { truncated: true, note: 'body exceeded 64 KiB and was truncated' };
    } else if (raw.length > 0) {
      payload = safeParse(raw) ?? raw;
    }

    const event = dispatcher.eventFromTrigger(trigger, {
      triggeredBy: 'webhook',
      payload,
      ...(c.req.header('idempotency-key') ? { idempotencyKey: c.req.header('idempotency-key')! } : {}),
      meta: {
        ...(c.req.header('x-forwarded-for') ? { ip: c.req.header('x-forwarded-for')! } : {}),
        ...(c.req.header('user-agent') ? { userAgent: c.req.header('user-agent')! } : {}),
      },
    });
    // payload_bytes reports the ORIGINAL size when truncated.
    const result = await dispatcher.dispatch(event);
    const extra = truncated ? { truncated: true, payloadBytes: bytes } : {};
    if (result.status === 'dispatched') return c.json({ ...result, ...extra }, 202);
    if (result.status === 'duplicate') return c.json({ ...result, ...extra }, 200);
    // disabled / skipped / failed are all "accepted but not executed"
    return c.json({ ...result, ...extra }, 409);
  });

  return router;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  // Constant-time-ish compare without node:crypto timingSafeEqual length rules.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
