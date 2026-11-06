/**
 * Debug routes — dev-only, loaded via **dynamic import** in index.ts so
 * production (NODE_ENV=production) never loads this module — including
 * /debug/db (raw SQL, agent self-testing tool).
 * Provides internal-state observation for self-testing.
 */

import { Hono } from 'hono';
import { config } from '../config.js';
import type { WorkerPool } from '../worker-pool.js';
import type { SessionRepo } from '../repos/session.repo.js';
import { sql } from 'drizzle-orm';
import type { DB } from '../db/init.js';
import type { AgentRepo } from '../repos/agent.repo.js';
import type { TriggerRuntime } from '../services/trigger/runtime.js';
import { listTriggerSources } from '../services/trigger/sources.js';

/** Keep webhook secrets out of debug output (末尾 4 位足够排查)。 */
function redactSecretConfig(config: Record<string, unknown>): Record<string, unknown> {
  const secret = config?.secret;
  if (typeof secret !== 'string') return config;
  return { ...config, secret: undefined, secretEnding: secret.slice(-4) };
}
import { extractExtensionNames, readSettings } from '../services/extension-utils.js';
import { getPluginSnapshot, resolveSessionPlugins } from '../services/plugins.js';

export function createDebugRouter(
  workerPool: WorkerPool,
  sessionRepo: SessionRepo,
  db: DB,
  agentRepo?: AgentRepo,
  triggerRt?: TriggerRuntime,
) {
  const router = new Hono();

  // ── Triggers (change: trigger-scheduling) ─────────────────────────────────
  router.get('/triggers', (c) => {
    if (!triggerRt) return c.json({ error: 'trigger runtime not initialized' }, 500);
    return c.json({
      disabled: triggerRt.flags.disabled,
      sources: listTriggerSources().map((s) => ({
        source: s.source,
        timeDriven: typeof s.computeNextAt === 'function',
        httpEntry: s.httpEntry === true,
        hasSecret: s.hasSecret === true,
      })),
      nextDueAt: triggerRt.repo.nextDueAt(),
      triggers: triggerRt.repo.list({ includeDisabled: true }).map((t) => ({
        ...t,
        config: redactSecretConfig(t.config),
        runs: triggerRt.repo.listRuns(t.id, 5),
      })),
    });
  });

  router.post('/triggers/:id/run', async (c) => {
    if (!triggerRt) return c.json({ error: 'trigger runtime not initialized' }, 500);
    const trigger = triggerRt.repo.get(c.req.param('id'));
    if (!trigger) return c.json({ error: 'trigger not found' }, 404);
    let payload: unknown;
    try {
      payload = (await c.req.json<{ payload?: unknown }>())?.payload;
    } catch {
      /* no body */
    }
    const event = triggerRt.dispatcher.eventFromTrigger(trigger, { triggeredBy: 'manual', payload });
    return c.json(await triggerRt.dispatcher.dispatch(event));
  });

  router.post('/triggers/tick', async (c) => {
    if (!triggerRt) return c.json({ error: 'trigger runtime not initialized' }, 500);
    await triggerRt.scheduler.tick();
    return c.json({ ok: true, nextDueAt: triggerRt.repo.nextDueAt() });
  });

  /** 插件闸门结果（只读，用于排查"为什么这个会话上没有某个插件"）。 */
  async function describePluginsForSession(agentId: string | null) {
    try {
      const snapshot = getPluginSnapshot(config.pluginsDir);
      if (snapshot.disabledByFlag) return { disabledByFlag: true, plugins: [] };
      const agent = agentId && agentRepo ? agentRepo.get(agentId) : null;
      const settings = await readSettings(config.agentDir);
      const resolved = resolveSessionPlugins({
        snapshot,
        agentExtensions: agent?.config?.extensions ?? [],
        installedPiExtensions: extractExtensionNames(settings),
      });
      return {
        disabledByFlag: false,
        plugins: resolved.map((p) => ({ id: p.id, enabled: p.enabled, reason: p.reason ?? null })),
      };
    } catch (err) {
      return { error: String(err) };
    }
  }

  router.get('/health', (c) => {
    return c.json({
      uptime: process.uptime(),
      isDev: config.isDev,
      activeSessions: sessionRepo.list('__none__').length, // approximation
      activeWorkers: workerPool.list().length,
    });
  });

  router.get('/sessions', (c) => {
    const workers = workerPool.list();
    const sessions = sessionRepo.list();
    return c.json({ sessions, workers });
  });

  router.get('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const session = sessionRepo.get(id);
    const worker = workerPool.get(id);
    // 插件闸门结果（change: plugin-mechanism）：解释"为什么这个会话上看不到某个插件"
    const plugins = await describePluginsForSession(session?.agentId ?? null);
    return c.json({
      session,
      worker: worker ? { workerPid: worker.workerPid, ready: worker.ready, stderrTail: worker.stderrTail, pendingCalls: worker.pendingCalls.size } : null,
      plugins,
    });
  });

  router.get('/workers', (c) => {
    return c.json({ workers: workerPool.list() });
  });

  // Direct SQL execution (dev only — not for prod)
  router.get('/db', (c) => {
    const query = c.req.query('sql');
    if (!query) return c.json({ error: 'Missing sql query param' }, 400);
    try {
      const result = db.all(sql.raw(query));
      return c.json({ rows: result });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  return router;
}