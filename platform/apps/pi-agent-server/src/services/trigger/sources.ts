/**
 * Trigger source registry (change: trigger-scheduling, capability `trigger-sources`).
 *
 * A `SourceSpec` describes CONFIG VALIDATION and TIME MATH only.
 * It deliberately has no `registerRoutes`: Hono's route table freezes after the
 * first request (`#addRoute` throws when `!isFresh`), so source-specific HTTP
 * entry points do not exist — `webhook` uses the platform's fixed route
 * `POST /api/hooks/:triggerId`. A plugin that wants an HTTP endpoint registers
 * its own route through `host.global.routes` and calls `host.triggers.fire`.
 */

export interface SourceSpec {
  /** Stable name persisted in `triggers.source`. */
  source: string;
  /** Human label for the UI source picker. */
  label?: string;
  /** One-line description shown under the label. */
  description?: string;
  /**
   * Validate + normalize `config`. Throw `Error(message)` on invalid input —
   * the message is surfaced verbatim as a field error in the UI.
   */
  validateConfig(config: Record<string, unknown>): Record<string, unknown>;
  /**
   * Next firing instant (epoch ms) strictly after `from`.
   * Return `null` for "no next firing" (e.g. `once` already consumed).
   * Sources without `computeNextAt` never participate in scheduling scans.
   */
  computeNextAt?(config: Record<string, unknown>, from: number): number | null;
  /** Periodic cleanup hook, called by the scheduler once per day. */
  housekeeping?(ctx: { deleteStaleDisabled(source: string, before: number): number }): void;
  /** `once` uses this to set `max_runs = 1` at creation. */
  defaultMaxRuns?: number;
  /** True when the source supplies an HTTP entry (platform renders curl hints). */
  httpEntry?: boolean;
  /** True when the source holds a secret (platform generates / rotates it). */
  hasSecret?: boolean;
}

const registry = new Map<string, SourceSpec>();

export function registerTriggerSource(spec: SourceSpec): void {
  if (!spec.source || typeof spec.source !== 'string') {
    throw new Error('trigger source needs a non-empty name');
  }
  if (registry.has(spec.source)) {
    // Duplicate registration is a developer error: reject loudly but keep the
    // first one so a buggy plugin cannot take over a built-in source.
    throw new Error(`trigger source already registered: ${spec.source}`);
  }
  registry.set(spec.source, spec);
}

export function getTriggerSource(name: string): SourceSpec | undefined {
  return registry.get(name);
}

export function listTriggerSources(): SourceSpec[] {
  return [...registry.values()];
}

export function registeredSourceNames(): string[] {
  return [...registry.keys()];
}

/** Test-only / hot-reload helper: drop everything (never used at runtime). */
export function resetTriggerSources(): void {
  registry.clear();
}
