/**
 * Capability control plane — the SINGLE entry for `invokeCapability` reverse
 * calls (worker → master), dispatched from the callServer tool.
 *
 * Flow: resolve ctx → builtin? → method exists → authorize → handler → audit.
 * Registered once in the server composition root (index.ts) at startup.
 */

import type { AgentRepo } from '../repos/agent.repo.js';
import type { SessionRepo } from '../repos/session.repo.js';
import type { AgentConfig, InvokeContext } from '@pi-agent-platform/shared-types';
import {
  availableMethods,
  CAPABILITY_MODULES,
  getCapability,
  isMethodAllowed,
  listCapabilities,
  resolveAllowedCapabilityMethods,
  resolveEffectiveCapabilities,
  type AllowResolution,
} from './registry.js';
import { authorizeCapability, CapabilityDeniedError, DEFAULT_POLICY } from './authorize.js';
import { auditCapability } from './audit.js';
import { childLogger } from '../logger.js';
import type { AgentRepo as AgentRepoT } from '../repos/agent.repo.js';
import type { SessionRepo as SessionRepoT } from '../repos/session.repo.js';
import type { WorkerPool as WorkerPoolT } from '../worker-pool.js';
import { registerCapability } from './registry.js';
import { serverCapabilities } from './handlers/server.js';
import { agentCapabilities } from './handlers/agent.js';
import { sessionCapabilities } from './handlers/session.js';

const logger = childLogger('capability');

export interface ControlPlaneDeps {
  agentRepo: AgentRepo;
  sessionRepo: SessionRepo;
  /** Used to resolve agentId for rowless placeholder sessions (WorkerEntry.agentId). */
  workerPool: WorkerPoolT;
}

/** sessions row first; fallback to the live WorkerEntry (placeholder, no row yet). */
function resolveSessionAgentId(deps: ControlPlaneDeps, sessionId: string): string | undefined {
  return deps.sessionRepo.get(sessionId)?.agentId ?? deps.workerPool.get(sessionId)?.agentId;
}

/** Unknown method error MUST include the (authorization-scoped) available method
 *  list so the model self-corrects with methods it can actually call. */
class UnknownMethodError extends Error {
  constructor(method: string, allow?: AllowResolution) {
    const scope = allow ? availableMethods(allow) : availableMethods();
    super(`Unknown capability method: ${method}. Available: ${scope.join(', ')}, list, detail`);
    this.name = 'UnknownMethodError';
  }
}

/** Builtin: grouped capability index — ONLY the caller's authorized methods
 *  (visibility == enforcement; every module is shown, even when empty). */
function runList(module: string | undefined, allow: AllowResolution): unknown {
  const groups = (module ? [module] : CAPABILITY_MODULES).map((m) => {
    const valid = CAPABILITY_MODULES.includes(m as never);
    if (!valid) {
      return { module: m, capabilities: [], error: `unknown module: ${m} (valid: ${CAPABILITY_MODULES.join(', ')})` };
    }
    return {
      module: m,
      capabilities: listCapabilities(m as never)
        .filter((d) => isMethodAllowed(allow, d.method))
        .map((d) => ({
          method: d.method,
          summary: d.summary,
          access: d.access,
          scoped: d.scoped,
        })),
    };
  });
  return { modules: groups, builtins: ['list', 'detail'] };
}

/** Builtin: full single-capability spec (schema + returns incl. effect timing).
 *  Unauthorized methods are NOT inspectable either — visibility == enforcement. */
function runDetail(method: string, allow: AllowResolution): unknown {
  const def = getCapability(method);
  if (!def) throw new UnknownMethodError(method, allow);
  if (!isMethodAllowed(allow, def.method)) {
    throw new CapabilityDeniedError(def.method, 'method not authorized for this session');
  }
  return {
    method: def.method,
    module: def.module,
    access: def.access,
    scoped: def.scoped,
    summary: def.summary,
    paramsSchema: def.paramsSchema,
    returns: def.returns,
  };
}

/** Dispatch with an explicit context — the core used by both the reverse-call
 *  entry (invokeCapability) and the dev-only debug endpoint (synthetic ctx).
 * Throws Error with model-readable messages on any failure — the worker tool
 * turns this into readable text; audit logs every attempt.
 */
export async function dispatchWithCtx(
  deps: ControlPlaneDeps,
  ctx: InvokeContext,
  method: string,
  params: unknown,
): Promise<unknown> {
  const started = Date.now();
  const agentConfig: AgentConfig | undefined = ctx.agentId
    ? deps.agentRepo.get(ctx.agentId)?.config
    : undefined;
  // capabilities 读取遵循 session 配置完全快照语义（与其他字段如 serverBuiltinTools /
  // systemPrompt 在 respawn 时的读取路径一致）：session 行 config 里有 `capabilities` key
  // （数组或显式 null）→ 用 session 的；key 缺失（存量 row，未快照过）→ fallback agent 行。
  // null（显式默认策略）与 undefined（没快照过）的语义差正是这条 fallback 的依据。
  const rowConfig = ctx.sessionId ? deps.sessionRepo.get(ctx.sessionId)?.config : undefined;
  // Shared resolver (registry) — the SAME function session-bridge uses when
  // pushing the description index, so visibility can never drift from enforcement.
  const effectiveConfig = resolveEffectiveCapabilities(rowConfig, agentConfig) as AgentConfig;
  const allow = resolveAllowedCapabilityMethods(effectiveConfig);

  // ---- Builtins: callable without allowlist gating, but CONTENT is scoped to
  // the caller's authorized methods (list filters; detail denies unauthorized). ----
  if (method === 'list' || method === 'detail') {
    try {
      const p = (params ?? {}) as { module?: string; method?: string };
      const result = method === 'list' ? runList(p.module, allow) : runDetail(p.method ?? '', allow);
      auditCapability({ ...ctx, method, params, status: 'ok', durationMs: Date.now() - started });
      return result;
    } catch (err) {
      const status = err instanceof UnknownMethodError ? 'unknown' : err instanceof CapabilityDeniedError ? 'denied' : 'error';
      auditCapability({
        ...ctx, method, params, status, durationMs: Date.now() - started,
        errorMessage: (err as Error).message,
      });
      throw err;
    }
  }

  // ---- Business method ----
  const def = getCapability(method);
  if (!def) {
    const err = new UnknownMethodError(method, allow);
    auditCapability({
      ...ctx, method, params, status: 'unknown', durationMs: Date.now() - started,
      errorMessage: err.message,
    });
    throw err;
  }

  try {
    const policy = DEFAULT_POLICY; // fixed own-scope safety net (not configurable)
    authorizeCapability(def, ctx, params, effectiveConfig, policy, {
      resolveSessionAgent: (sid) => resolveSessionAgentId(deps, sid),
    });
  } catch (err) {
    auditCapability({
      ...ctx, method, params, status: 'denied', durationMs: Date.now() - started,
      errorMessage: (err as Error).message,
    });
    throw err;
  }

  try {
    const result = await def.handler(ctx, params);
    auditCapability({ ...ctx, method, params, status: 'ok', durationMs: Date.now() - started });
    return result;
  } catch (err) {
    auditCapability({
      ...ctx, method, params, status: 'error', durationMs: Date.now() - started,
      errorMessage: (err as Error).message,
    });
    throw err;
  }
}

/** Register ALL v1 business capabilities + channel/config empty-module placeholders.
 *  Add/remove a capability = touch this function only. */
export function registerAllCapabilities(deps: {
  agentRepo: AgentRepoT;
  sessionRepo: SessionRepoT;
  workerPool: WorkerPoolT;
  serverOpts: { nodeEnv: string; port: number; maxWorkers: number };
}): void {
  registerCapability; // no-op reference; kept import explicit above
  for (const def of [
    ...serverCapabilities(deps.workerPool, deps.serverOpts),
    ...agentCapabilities(deps.agentRepo),
    ...sessionCapabilities(deps.agentRepo, deps.sessionRepo, deps.workerPool),
    // channel.* / config.* modules: registered empty (group placeholder, list shows them)
  ]) {
    registerCapability(def);
  }
}

/** Register the single reverse-call handler: `invokeCapability` → dispatch. */
export function installControlPlane(
  deps: ControlPlaneDeps & {
    registerReverseCallHandler: (method: string, handler: (sessionId: string, args: unknown[]) => Promise<unknown>) => void;
  },
): void {
  const { registerReverseCallHandler, ...depsOnly } = deps;
  registerReverseCallHandler('invokeCapability', async (sessionId, args) => {
    const [method, params] = args as [string, unknown];
    if (typeof method !== 'string' || method.length === 0) {
      throw new Error('invokeCapability: missing method (contract: [method, params?])');
    }
    return invokeCapability(depsOnly, sessionId, method, params);
  });
  logger.info(
    { methods: availableMethods() },
    'capability control plane installed (invokeCapability)',
  );
}

/** Reverse-call entry: resolve caller identity from the sessions row, then dispatch. */
export async function invokeCapability(
  deps: ControlPlaneDeps,
  callerSessionId: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const ctx: InvokeContext = {
    sessionId: callerSessionId,
    agentId: resolveSessionAgentId(deps, callerSessionId),
  };
  return dispatchWithCtx(deps, ctx, method, params);
}
