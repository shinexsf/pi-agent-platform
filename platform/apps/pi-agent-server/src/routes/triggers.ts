/**
 * Trigger CRUD (change: trigger-scheduling).
 *
 * Flat routes (`/api/triggers`) rather than agent-scoped ones — the web console
 * lists across agents and needs `agentId` only at create time.
 *
 * All validation of source-specific config is delegated to
 * `SourceSpec.validateConfig` — this file MUST NOT duplicate those rules.
 */

import { Hono } from 'hono';
import type { CreateTriggerRequest, UpdateTriggerRequest } from '@pi-agent-platform/api-types';
import type { AgentRepo } from '../repos/agent.repo.js';
import type { TriggerDTO, TriggerSessionMode } from '@pi-agent-platform/shared-types';
import type { TriggerRuntime } from '../services/trigger/runtime.js';
import { getTriggerSource, listTriggerSources } from '../services/trigger/sources.js';
import { generateWebhookSecret } from '../services/trigger/sources/webhook.js';
import { resolveSessionBinding } from '../services/trigger/session-binding.js';

/** Per-agent trigger cap (platform guard, not a source concern). */
export const MAX_TRIGGERS_PER_AGENT = 10;

function badRequest(message: string): Error {
  const e = new Error(message);
  e.name = 'ValidationError';
  return e;
}

function toDTOWithAgent(trigger: TriggerDTO, agentRepo: AgentRepo): TriggerDTO {
  return { ...trigger, agentName: agentRepo.get(trigger.agentId)?.name };
}

/** Only webhook sources hold a secret; keep plaintext out of list/detail. */
function redactSecret(trigger: TriggerDTO): TriggerDTO {
  const secret = trigger.config?.secret;
  if (typeof secret !== 'string') return trigger;
  return {
    ...trigger,
    config: { ...trigger.config, secret: undefined, secretEnding: secret.slice(-4) },
  };
}

export function createTriggersRouter(agentRepo: AgentRepo, rt: TriggerRuntime) {
  const router = new Hono();
  const { repo, dispatcher, scheduler } = rt;

  // GET /api/triggers?agentId=&source=&includeDisabled=
  router.get('/', (c) => {
    const includeDisabled = c.req.query('includeDisabled') === '1';
    const items = repo
      .list({
        agentId: c.req.query('agentId') || undefined,
        source: c.req.query('source') || undefined,
        includeDisabled,
      })
      .map((t) => redactSecret(toDTOWithAgent(t, agentRepo)));
    return c.json({ items, sources: listTriggerSources().map(sourcePublicShape) });
  });

  // POST /api/triggers
  router.post('/', async (c) => {
    let body: CreateTriggerRequest;
    try {
      body = await c.req.json<CreateTriggerRequest>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!body?.agentId) return c.json({ error: 'agentId is required' }, 400);
    const agent = agentRepo.get(body.agentId);
    if (!agent) return c.json({ error: `agent not found: ${body.agentId}` }, 404);
    if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);
    if (!body.prompt?.trim()) return c.json({ error: 'prompt is required' }, 400);

    const spec = getTriggerSource(body.source);
    if (!spec) {
      return c.json(
        { error: `unknown source: ${body.source}`, available: listTriggerSources().map((s) => s.source) },
        400,
      );
    }
    if (repo.countEnabledForAgent(body.agentId) >= MAX_TRIGGERS_PER_AGENT) {
      return c.json({ error: `每 agent 最多 ${MAX_TRIGGERS_PER_AGENT} 个启用的触发器` }, 400);
    }

    // Secrets are server-generated BEFORE validation: the UI never invents one
    // and `webhook.validateConfig` requires a ≥16-char secret to exist.
    const rawConfig: Record<string, unknown> = { ...(body.config ?? {}) };
    if (spec.hasSecret && (typeof rawConfig.secret !== 'string' || rawConfig.secret.length < 16)) {
      rawConfig.secret = generateWebhookSecret();
    }
    let config: Record<string, unknown>;
    try {
      config = spec.validateConfig(rawConfig);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    const sessionMode: TriggerSessionMode = body.sessionMode === 'reuse' ? 'reuse' : 'new';
    // reuse 目标会话：有值 = 绑定已有会话（必须是本 agent 的），空 = 首次触发时创建。
    let sessionId: string | null;
    try {
      sessionId = resolveSessionBinding(rt.sessionRepo, {
        agentId: body.agentId,
        sessionMode,
        sessionId: body.sessionId,
      });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    const maxRuns =
      body.maxRuns === undefined || body.maxRuns === null || body.maxRuns === 0
        ? (spec.defaultMaxRuns ?? null)
        : body.maxRuns;
    const now = Date.now();
    const nextAt = spec.computeNextAt ? spec.computeNextAt(config, now) : null;

    const created = repo.create({
      agentId: body.agentId,
      name: body.name.trim(),
      source: body.source,
      config,
      prompt: body.prompt,
      sessionMode,
      enabled: body.enabled !== false,
      nextAt,
      maxRuns,
      sessionId,
    });
    scheduler.reschedule();
    const dto = redactSecret(toDTOWithAgent(created, agentRepo));
    // The ONLY moment the plaintext secret leaves the server (besides rotate).
    return c.json(
      { ...dto, ...(spec.hasSecret ? { secret: config.secret } : {}) },
      201,
    );
  });

  // GET /api/triggers/:id
  router.get('/:id', (c) => {
    const trigger = repo.get(c.req.param('id'));
    if (!trigger) return c.json({ error: 'trigger not found' }, 404);
    return c.json({
      ...redactSecret(toDTOWithAgent(trigger, agentRepo)),
      recentRuns: repo.listRuns(trigger.id, 20),
    });
  });

  // PATCH /api/triggers/:id
  router.patch('/:id', async (c) => {
    const id = c.req.param('id');
    const existing = repo.get(id);
    if (!existing) return c.json({ error: 'trigger not found' }, 404);
    let body: UpdateTriggerRequest;
    try {
      body = await c.req.json<UpdateTriggerRequest>();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const spec = getTriggerSource(existing.source);
    if (!spec) return c.json({ error: `unknown source: ${existing.source}` }, 400);

    let config = existing.config;
    if (body.config !== undefined) {
      try {
        // Preserve the server-owned secret unless explicitly rotated.
        config = spec.validateConfig({ ...body.config, secret: existing.config.secret });
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    }
    // Re-enabling must NOT replay a stale slot: if `next_at` sat in the past
    // while the trigger was off, the scheduler would fire it the instant it is
    // switched back on. Recompute from "now" instead.
    const reEnabling = body.enabled === true && !existing.enabled;
    const nextAt =
      body.reschedule || body.config !== undefined || reEnabling
        ? (spec.computeNextAt?.(config, Date.now()) ?? null)
        : undefined;
    // 会话绑定：切到 new 一律清空；reuse 下带了 sessionId 就校验并换绑/解绑，
    // 只改 sessionMode 不动 sessionId 时按原有绑定校验（防止绕道改成他 agent 的会话）。
    let sessionId: string | null | undefined;
    if (body.sessionId !== undefined || body.sessionMode !== undefined) {
      const sessionMode = body.sessionMode ?? existing.sessionMode;
      try {
        sessionId =
          sessionMode === 'reuse'
            ? resolveSessionBinding(rt.sessionRepo, {
                agentId: existing.agentId,
                sessionMode,
                sessionId: body.sessionId === undefined ? existing.sessionId : body.sessionId,
              })
            : null;
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    }

    const effectiveMaxRuns = body.maxRuns === undefined ? existing.maxRuns : body.maxRuns;
    if (body.enabled === true && effectiveMaxRuns !== null && existing.runsCount >= effectiveMaxRuns) {
      return c.json(
        { error: `已达最大运行次数（${existing.runsCount}/${effectiveMaxRuns}），请先提高 maxRuns` },
        400,
      );
    }

    const updated = repo.update(id, {
      name: body.name?.trim(),
      config,
      prompt: body.prompt,
      sessionMode: body.sessionMode,
      ...(sessionId !== undefined ? { sessionId } : {}),
      enabled: body.enabled,
      maxRuns: body.maxRuns === undefined ? undefined : body.maxRuns,
      ...(nextAt !== undefined ? { nextAt } : {}),
    });
    scheduler.reschedule();
    return c.json(updated ? redactSecret(toDTOWithAgent(updated, agentRepo)) : { error: 'trigger not found' }, 200);
  });

  // DELETE /api/triggers/:id
  router.delete('/:id', (c) => {
    const ok = repo.delete(c.req.param('id'));
    if (!ok) return c.json({ error: 'trigger not found' }, 404);
    scheduler.reschedule();
    return c.json({ ok: true });
  });

  // POST /api/triggers/:id/run — manual fire (adapter: build event from the row).
  router.post('/:id/run', async (c) => {
    const trigger = repo.get(c.req.param('id'));
    if (!trigger) return c.json({ error: 'trigger not found' }, 404);
    let payload: unknown;
    if (c.req.header('content-type')?.includes('application/json')) {
      try {
        payload = (await c.req.json<{ payload?: unknown }>())?.payload;
      } catch {
        /* empty body is fine */
      }
    }
    const event = dispatcher.eventFromTrigger(trigger, { triggeredBy: 'manual', payload });
    const result = await dispatcher.dispatch(event);
    const status = result.status === 'dispatched' || result.status === 'skipped' ? 200 : 409;
    return c.json(result, status);
  });

  // GET /api/triggers/:id/runs?limit=
  router.get('/:id/runs', (c) => {
    const id = c.req.param('id');
    if (!repo.get(id)) return c.json({ error: 'trigger not found' }, 404);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
    return c.json({ items: repo.listRuns(id, limit) });
  });

  // POST /api/triggers/:id/rotate-secret — new plaintext, returned once.
  router.post('/:id/rotate-secret', (c) => {
    const id = c.req.param('id');
    const trigger = repo.get(id);
    if (!trigger) return c.json({ error: 'trigger not found' }, 404);
    const spec = getTriggerSource(trigger.source);
    if (!spec?.hasSecret) return c.json({ error: `source ${trigger.source} has no secret` }, 400);
    const secret = generateWebhookSecret();
    repo.update(id, { config: { ...trigger.config, secret } });
    return c.json({ id, secret });
  });

  return router;
}

/** Public description of a source for the UI source picker. */
export function sourcePublicShape(spec: {
  source: string;
  label?: string;
  description?: string;
  httpEntry?: boolean;
  hasSecret?: boolean;
  computeNextAt?: unknown;
}) {
  return {
    source: spec.source,
    label: spec.label ?? spec.source,
    description: spec.description ?? '',
    timeDriven: typeof spec.computeNextAt === 'function',
    httpEntry: spec.httpEntry === true,
    hasSecret: spec.hasSecret === true,
  };
}

export { badRequest };
