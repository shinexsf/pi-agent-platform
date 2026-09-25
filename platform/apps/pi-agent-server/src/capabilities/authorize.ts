/**
 * Authorization for capability dispatch — TWO layers, both enforced master-side
 * (trust boundary: the worker is never trusted with this decision):
 *
 * Layer 1 — per-session allowlist (`AgentConfig.capabilities`, session-snapshot):
 *   null/undefined → NOT authorized (explicit opt-in required — no default set)
 *   []             → deny all business methods (list/detail stay callable, content empty)
 *   string[]       → exactly these methods
 *
 * Layer 2 — fixed own-scope safety net (HARDCODED, no config-file knob —
 *   2026-09-24 product decision: authorization comes only from agent/session
 *   config; the global file only carries default TOOL switches):
 *   read='all' (personal platform, cross-agent reads visible), write='own'
 *   (a scoped write may only target the caller's own agent/session rows).
 *
 * Failure mode: anything unresolved (missing session row, missing target id)
 * fails CLOSED in own mode.
 */

import type { AgentConfig, AnyCapabilityDef, InvokeContext } from '@pi-agent-platform/shared-types';
import { resolveAllowedCapabilityMethods } from './registry.js';
import { childLogger } from '../logger.js';

const logger = childLogger('capability-authz');

export interface CapabilityPolicy {
  read: 'all' | 'own';
  write: 'all' | 'own';
}

/** Fixed scope policy — NOT configurable (no config-file knob; see header). */
export const DEFAULT_POLICY: CapabilityPolicy = { read: 'all', write: 'own' };

export class CapabilityDeniedError extends Error {
  constructor(method: string, reason: string) {
    super(`Capability denied: ${method} — ${reason}`);
    this.name = 'CapabilityDeniedError';
  }
}

function ownsTarget(
  def: AnyCapabilityDef,
  ctx: InvokeContext,
  params: unknown,
  resolveSessionAgent: (sessionId: string) => string | undefined,
): boolean {
  const id = (params as { id?: unknown } | undefined)?.id;
  if (typeof id !== 'string' || id.length === 0) return false;
  if (def.module === 'agent') return id === ctx.agentId;
  if (def.module === 'session') {
    const owner = resolveSessionAgent(id);
    return owner !== undefined && owner !== undefined && owner === ctx.agentId;
  }
  return false;
}

export interface AuthorizeDeps {
  /** Resolve the agent that owns a session id (sessions row); undefined if none. */
  resolveSessionAgent: (sessionId: string) => string | undefined;
}

/**
 * Throws CapabilityDeniedError when the call must not proceed.
 * Builtin methods (list/detail) never reach this function.
 */
export function authorizeCapability(
  def: AnyCapabilityDef,
  ctx: InvokeContext,
  params: unknown,
  agentConfig: AgentConfig | undefined,
  policy: CapabilityPolicy,
  deps: AuthorizeDeps,
): void {
  // ---- Layer 1: per-session allowlist (shared resolution: authorize == description == list) ----
  const allow = resolveAllowedCapabilityMethods(agentConfig);
  if (allow.kind === 'unset') {
    throw new CapabilityDeniedError(
      def.method,
      'no explicit `capabilities` configured for this session/agent (authorization is opt-in — nothing enabled by default)',
    );
  }
  if (allow.kind === 'empty') {
    throw new CapabilityDeniedError(
      def.method,
      'capabilities allowlist is empty (all business methods disabled)',
    );
  }
  if (!allow.methods.has(def.method)) {
    throw new CapabilityDeniedError(def.method, 'method not in agent capabilities allowlist');
  }

  // ---- Layer 2: fixed scope policy (hardcoded, see header) ----
  const mode = def.access === 'read' ? policy.read : policy.write;
  if (mode === 'all') return;
  // mode === 'own': only non-scoped capabilities pass freely;
  // scoped ones must target the caller's own agent/session.
  if (!def.scoped) return;
  if (!ownsTarget(def, ctx, params, deps.resolveSessionAgent)) {
    logger.warn(
      { sessionId: ctx.sessionId, agentId: ctx.agentId, method: def.method, mode },
      'capability denied by own-mode scope check',
    );
    throw new CapabilityDeniedError(def.method, `own mode: caller may only target its own ${def.module} rows`);
  }
}
