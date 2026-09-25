/**
 * Capability registry — single source of truth for all server-management
 * capabilities exposed to agents via the callServer tool.
 *
 * Add/remove a capability = register here (or don't); workers pick the change
 * up on next spawn (RuntimeConfig.capabilityIndex), dispatch resolves against
 * this registry at call time. No worker code, no ReverseMethod union changes.
 */

import type {
  AgentConfig,
  AnyCapabilityDef,
  CapabilityDef,
  CapabilityIndexEntry,
  CapabilityModule,
} from '@pi-agent-platform/shared-types';

/** All known modules — `list` shows every one of these (empty groups included). */
export const CAPABILITY_MODULES: readonly CapabilityModule[] = [
  'server',
  'agent',
  'session',
  'channel',
  'config',
] as const;

const defs = new Map<string, AnyCapabilityDef>();

export function registerCapability(def: AnyCapabilityDef): void {
  if (defs.has(def.method)) {
    throw new Error(`capability already registered: ${def.method}`);
  }
  // Enforce dotted '<module>.<action>' naming so list/detail grouping stays sane.
  if (!def.method.startsWith(`${def.module}.`)) {
    throw new Error(`capability method "${def.method}" must start with its module "${def.module}."`);
  }
  defs.set(def.method, def);
}

export function getCapability(method: string): AnyCapabilityDef | undefined {
  return defs.get(method);
}

/** All registered capability defs, optionally filtered by module. */
export function listCapabilities(module?: CapabilityModule): AnyCapabilityDef[] {
  const all = [...defs.values()];
  return module ? all.filter((d) => d.module === module) : all;
}

/**
 * Resolved per-session method authorization (Layer 1 of the two-gate model).
 * SINGLE implementation consumed by: authorize (dispatch), description index
 * filtering (spawn), and builtin list/detail — they can never drift apart.
 */
export type AllowResolution =
  /** capabilities null/undefined → NOT authorized (explicit allowlist required). */
  | { kind: 'unset' }
  /** capabilities [] → deny all business methods. */
  | { kind: 'empty' }
  /** capabilities: string[] → strict allowlist. */
  | { kind: 'explicit'; methods: Set<string> };

/** UNSET AND EMPTY BOTH RESOLVE TO ZERO METHODS — authorization is opt-in only:
 *  no configured capabilities ⇒ no business methods, even when the callServer
 *  tool itself is globally enabled (2026-09-24 product decision). */

export function resolveAllowedCapabilityMethods(config?: { capabilities?: string[] | null } | null): AllowResolution {
  const c = config?.capabilities;
  if (c === undefined || c === null) return { kind: 'unset' };
  if (c.length === 0) return { kind: 'empty' };
  return { kind: 'explicit', methods: new Set(c) };
}

/** Is `method` callable under this resolution? (Layer-1 check only — own/all target
 *  scoping is Layer 2 and depends on params, so it never affects visibility.) */
export function isMethodAllowed(allow: AllowResolution, method: string): boolean {
  if (allow.kind === 'empty' || allow.kind === 'unset') return false;
  return allow.methods.has(method);
}

/** The capability defs effective under a resolution (description/list/error filtering). */
export function allowedMethodsUnder(allow: AllowResolution): AnyCapabilityDef[] {
  if (allow.kind === 'empty' || allow.kind === 'unset') return [];
  return [...defs.values()].filter((d) => allow.methods.has(d.method));
}

/** Effective capabilities under the session-snapshot semantics:
 *  row config HAS the key (array or explicit null) → row wins; key absent
 *  (legacy row, never snapshotted) → fall back to the agent config.
 *  Shared by dispatch (capabilities/index.ts) and spawn-time index push
 *  (session-bridge buildRuntimeConfig) so visibility == enforcement. */
export function resolveEffectiveCapabilities(
  rowConfig: { capabilities?: string[] | null } | null | undefined,
  agentConfig: { capabilities?: string[] | null } | null | undefined,
): { capabilities?: string[] | null } {
  if (rowConfig && 'capabilities' in rowConfig) {
    return { capabilities: rowConfig.capabilities };
  }
  return { capabilities: agentConfig?.capabilities };
}

/** Compact index pushed to workers at createSession (RuntimeConfig.capabilityIndex)
 *  so the callServer tool description can embed it — zero-round-trip first use.
 *  Filtered by the caller's effective authorization: the description lists ONLY
 *  what this session may call; builtin list/detail use the same resolution. */
export function buildCapabilityIndex(config?: { capabilities?: string[] | null } | null): CapabilityIndexEntry[] {
  const allow = resolveAllowedCapabilityMethods(config);
  return allowedMethodsUnder(allow).map((d) => ({
    method: d.method,
    module: d.module,
    access: d.access,
    scoped: d.scoped,
    summary: d.summary,
  }));
}

/** Available business method names — used by the unknown-method error message.
 *  Pass an AllowResolution to scope the list to what the caller may invoke. */
export function availableMethods(allow?: AllowResolution): string[] {
  const pool = allow ? allowedMethodsUnder(allow) : [...defs.values()];
  return pool.map((d) => d.method).sort();
}
