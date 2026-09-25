/**
 * Capability debug router — dev-only observability + L1 test entry for the
 * callServer control plane (replaces hand-driving a LLM turn for the
 * deterministic authorization/dispatch matrix; see pi-agent-server_debug-testing).
 *
 * GET  /debug/capabilities            — full state: policy + registry (grouped) + optional agent resolution
 * POST /debug/capabilities/invoke     — dispatch with SYNTHETIC ctx via the exact production path
 *
 * Debug code depends on production code (one-way), never the reverse;
 * loaded only under `config.isDev` via dynamic import in the composition root.
 */

import { Hono } from 'hono';
import type { AgentRepo } from '../repos/agent.repo.js';
import type { SessionRepo } from '../repos/session.repo.js';
import type { WorkerPool } from '../worker-pool.js';
import { CAPABILITY_MODULES, listCapabilities, availableMethods } from '../capabilities/registry.js';
import { DEFAULT_POLICY } from '../capabilities/authorize.js';
import { dispatchWithCtx } from '../capabilities/index.js';

export function createCapabilityDebugRouter(agentRepo: AgentRepo, sessionRepo: SessionRepo, workerPool: WorkerPool) {
  const router = new Hono();

  // Full state, one shot (no pagination — debug endpoint rule).
  router.get('/', (c) => {
    const agentId = c.req.query('agentId');
    const agent = agentId ? agentRepo.get(agentId) : undefined;
    return c.json({
      policy: DEFAULT_POLICY,
      policySource: 'hardcoded (not configurable — authorization comes from agent/session config)',
      defaultPolicy: DEFAULT_POLICY,
      methods: availableMethods(),
      modules: CAPABILITY_MODULES.map((m) => ({
        module: m,
        capabilities: listCapabilities(m).map((d) => ({
          method: d.method,
          access: d.access,
          scoped: d.scoped,
          summary: d.summary,
          returns: d.returns,
        })),
      })),
      agent: agent
        ? {
            id: agent.id,
            name: agent.name,
            serverBuiltinTools: agent.config?.serverBuiltinTools ?? null,
            capabilities: agent.config?.capabilities ?? null,
          }
        : null,
    });
  });

  // Dispatch through the production code path with a synthetic ctx.
  // Body: { method, params?, sessionId? | agentId? } — sessionId resolves the
  // caller identity exactly like a real reverse call; agentId alone fakes it
  // (debug-only, bypasses nothing: authorize still runs).
  router.post('/invoke', async (c) => {
    const body = (await c.req.json()) as {
      method?: string;
      params?: unknown;
      sessionId?: string;
      agentId?: string;
    };
    if (!body.method) return c.json({ error: 'missing method' }, 400);

    const session = body.sessionId ? sessionRepo.get(body.sessionId) : undefined;
    const ctx = {
      sessionId: body.sessionId ?? `debug:${body.agentId ?? 'anonymous'}`,
      agentId: session?.agentId ?? (body.sessionId ? workerPool.get(body.sessionId)?.agentId : undefined) ?? body.agentId,
    };

    try {
      const result = await dispatchWithCtx({ agentRepo, sessionRepo, workerPool }, ctx, body.method, body.params);
      return c.json({ ok: true, ctx, result });
    } catch (err) {
      return c.json({ ok: false, ctx, error: (err as Error).message }, 400);
    }
  });

  return router;
}
