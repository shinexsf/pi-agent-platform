/**
 * Trigger repository (change: trigger-scheduling).
 *
 * One table for every source: `config` is JSON, `next_at` is a real column so
 * the scheduler can scan it. `claimNextAt` is a conditional UPDATE — the
 * scheduler and a concurrent run-now must never both "own" the same firing.
 */

import { and, asc, desc, eq, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DB } from '../db/init.js';
import { triggers, triggerRuns } from '../db/schema.js';
import type {
  TriggerDTO,
  TriggerRunDTO,
  TriggerRunStatus,
  TriggerSessionMode,
  TriggeredBy,
} from '@pi-agent-platform/shared-types';

type TriggerRow = typeof triggers.$inferSelect;
type RunRow = typeof triggerRuns.$inferSelect;

function rowToDTO(row: TriggerRow): TriggerDTO {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    source: row.source,
    config: parseJson<Record<string, unknown>>(row.config, {}),
    prompt: row.prompt,
    sessionMode: row.sessionMode as TriggerSessionMode,
    enabled: row.enabled !== 0,
    nextAt: row.nextAt,
    maxRuns: row.maxRuns,
    runsCount: row.runsCount,
    sessionId: row.sessionId,
    lastFiredAt: row.lastFiredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function runToDTO(row: RunRow): TriggerRunDTO {
  return {
    id: row.id,
    triggerId: row.triggerId,
    status: row.status as TriggerRunStatus,
    triggeredBy: row.triggeredBy as TriggeredBy,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    sessionId: row.sessionId,
    error: row.error,
    payloadBytes: row.payloadBytes,
  };
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface CreateTriggerInput {
  agentId: string;
  name: string;
  source: string;
  config: Record<string, unknown>;
  prompt: string;
  sessionMode: TriggerSessionMode;
  enabled: boolean;
  nextAt: number | null;
  maxRuns: number | null;
}

export interface UpdateTriggerInput {
  name?: string;
  config?: Record<string, unknown>;
  prompt?: string;
  sessionMode?: TriggerSessionMode;
  enabled?: boolean;
  nextAt?: number | null;
  maxRuns?: number | null;
  runsCount?: number;
  sessionId?: string | null;
  lastFiredAt?: number | null;
}

export function createTriggerRepo(db: DB) {
  return {
    create(input: CreateTriggerInput): TriggerDTO {
      const now = Date.now();
      const id = randomUUID();
      db.insert(triggers)
        .values({
          id,
          agentId: input.agentId,
          name: input.name,
          source: input.source,
          config: JSON.stringify(input.config ?? {}),
          prompt: input.prompt,
          sessionMode: input.sessionMode,
          enabled: input.enabled ? 1 : 0,
          nextAt: input.nextAt,
          maxRuns: input.maxRuns,
          runsCount: 0,
          sessionId: null,
          lastFiredAt: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      return rowToDTO(this.getRow(id)!);
    },

    getRow(id: string): TriggerRow | undefined {
      return db.select().from(triggers).where(eq(triggers.id, id)).get();
    },

    get(id: string): TriggerDTO | undefined {
      const row = this.getRow(id);
      return row ? rowToDTO(row) : undefined;
    },

    list(filter?: { agentId?: string; source?: string; includeDisabled?: boolean }): TriggerDTO[] {
      const conditions = [];
      if (filter?.agentId) conditions.push(eq(triggers.agentId, filter.agentId));
      if (filter?.source) conditions.push(eq(triggers.source, filter.source));
      let rows =
        conditions.length > 0
          ? db
              .select()
              .from(triggers)
              .where(and(...conditions))
              .all()
          : db.select().from(triggers).all();
      if (!filter?.includeDisabled) rows = rows.filter((r) => r.enabled !== 0);
      rows.sort((a, b) => b.createdAt - a.createdAt);
      return rows.map(rowToDTO);
    },

    /** Count of ENABLED triggers for one agent (quota guard, ≤10). */
    countEnabledForAgent(agentId: string): number {
      return db
        .select()
        .from(triggers)
        .where(and(eq(triggers.agentId, agentId), eq(triggers.enabled, 1)))
        .all().length;
    },

    update(id: string, patch: UpdateTriggerInput): TriggerDTO | undefined {
      const values: Record<string, unknown> = { updatedAt: Date.now() };
      if (patch.name !== undefined) values.name = patch.name;
      if (patch.config !== undefined) values.config = JSON.stringify(patch.config);
      if (patch.prompt !== undefined) values.prompt = patch.prompt;
      if (patch.sessionMode !== undefined) values.sessionMode = patch.sessionMode;
      if (patch.enabled !== undefined) values.enabled = patch.enabled ? 1 : 0;
      if (patch.nextAt !== undefined) values.nextAt = patch.nextAt;
      if (patch.maxRuns !== undefined) values.maxRuns = patch.maxRuns;
      if (patch.runsCount !== undefined) values.runsCount = patch.runsCount;
      if (patch.sessionId !== undefined) values.sessionId = patch.sessionId;
      if (patch.lastFiredAt !== undefined) values.lastFiredAt = patch.lastFiredAt;
      db.update(triggers).set(values).where(eq(triggers.id, id)).run();
      return this.get(id);
    },

    delete(id: string): boolean {
      const existing = this.getRow(id);
      if (!existing) return false;
      db.delete(triggers).where(eq(triggers.id, id)).run();
      return true;
    },

    /** Enabled triggers whose `next_at` is due. Ordered so the scheduler can
     *  take the head as "the next firing". */
    listDue(now: number): TriggerDTO[] {
      return db
        .select()
        .from(triggers)
        .where(and(eq(triggers.enabled, 1), isNotNull(triggers.nextAt), lte(triggers.nextAt, now)))
        .all()
        .map(rowToDTO)
        .sort((a, b) => (a.nextAt ?? 0) - (b.nextAt ?? 0));
    },

    /** Earliest `next_at` among enabled triggers (scheduler timer target). */
    nextDueAt(): number | null {
      const row = db
        .select()
        .from(triggers)
        .where(and(eq(triggers.enabled, 1), isNotNull(triggers.nextAt)))
        .orderBy(asc(triggers.nextAt))
        .limit(1)
        .get();
      return row?.nextAt ?? null;
    },

    /** Conditional advance: only succeeds if `next_at` is still `expected`.
     *  Returns false when someone else already moved it (run-now / another fire). */
    claimNextAt(id: string, expected: number, nextAt: number | null): boolean {
      const res = db
        .update(triggers)
        .set({ nextAt, updatedAt: Date.now() })
        .where(and(eq(triggers.id, id), eq(triggers.nextAt, expected)))
        .run();
      return res.changes > 0;
    },

    /** Stop a trigger for good (`max_runs` reached / once consumed). */
    disable(id: string): void {
      db.update(triggers)
        .set({ enabled: 0, nextAt: null, updatedAt: Date.now() })
        .where(eq(triggers.id, id))
        .run();
    },

    listAgentIdsWithTriggers(): string[] {
      return db
        .select({ agentId: triggers.agentId })
        .from(triggers)
        .all()
        .map((r) => r.agentId);
    },

    // ── runs ────────────────────────────────────────────────────────────────

    createRun(input: {
      triggerId: string;
      status: TriggerRunStatus;
      triggeredBy: TriggeredBy;
      idempotencyKey?: string | null;
      startedAt?: number;
      sessionId?: string | null;
      error?: string | null;
      payloadBytes?: number | null;
      finishedAt?: number | null;
    }): string {
      const id = randomUUID();
      db.insert(triggerRuns)
        .values({
          id,
          triggerId: input.triggerId,
          status: input.status,
          triggeredBy: input.triggeredBy,
          idempotencyKey: input.idempotencyKey ?? null,
          startedAt: input.startedAt ?? Date.now(),
          finishedAt: input.finishedAt ?? null,
          sessionId: input.sessionId ?? null,
          error: input.error ?? null,
          payloadBytes: input.payloadBytes ?? null,
        })
        .run();
      return id;
    },

    finishRun(
      id: string,
      patch: {
        status?: TriggerRunStatus;
        sessionId?: string | null;
        error?: string | null;
        finishedAt?: number;
      },
    ): void {
      const values: Record<string, unknown> = { finishedAt: patch.finishedAt ?? Date.now() };
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.sessionId !== undefined) values.sessionId = patch.sessionId;
      if (patch.error !== undefined) values.error = patch.error;
      db.update(triggerRuns).set(values).where(eq(triggerRuns.id, id)).run();
    },

    listRuns(triggerId: string, limit = 50): TriggerRunDTO[] {
      return db
        .select()
        .from(triggerRuns)
        .where(eq(triggerRuns.triggerId, triggerId))
        .orderBy(desc(triggerRuns.startedAt))
        .limit(limit)
        .all()
        .map(runToDTO);
    },

    /** Overlap guard: does this trigger have a run that never finished?
     *  Runs older than `staleAfterMs` are ignored — a crashed/hung run must not
     *  block the trigger forever (startup sweeps them, see `finalizeStaleRuns`). */
    hasRunningRun(triggerId: string, staleAfterMs = 30 * 60 * 1000): boolean {
      const since = Date.now() - staleAfterMs;
      return (
        db
          .select({ id: triggerRuns.id })
          .from(triggerRuns)
          .where(
            and(
              eq(triggerRuns.triggerId, triggerId),
              sql`${triggerRuns.finishedAt} IS NULL`,
              sql`${triggerRuns.startedAt} >= ${since}`,
            ),
          )
          .limit(1)
          .get() !== undefined
      );
    },

    /** Mark never-finished runs as failed (server restart / crashed run). */
    finalizeStaleRuns(before: number): number {
      const res = db
        .update(triggerRuns)
        .set({ status: 'failed', finishedAt: Date.now(), error: 'stale: run never completed' })
        .where(and(sql`${triggerRuns.finishedAt} IS NULL`, sql`${triggerRuns.startedAt} < ${before}`))
        .run();
      return res.changes;
    },

    /** Idempotency window: same trigger + same key inside `sinceMs`. */
    hasRecentIdempotencyKey(triggerId: string, key: string, sinceMs: number): boolean {
      return (
        db
          .select({ id: triggerRuns.id })
          .from(triggerRuns)
          .where(
            and(
              eq(triggerRuns.triggerId, triggerId),
              eq(triggerRuns.idempotencyKey, key),
              sql`${triggerRuns.startedAt} >= ${sinceMs}`,
            ),
          )
          .limit(1)
          .get() !== undefined
      );
    },

    /** Attribution for the session detail page (`trigger_runs.session_id` hit). */
    findRunBySession(sessionId: string): TriggerRunDTO | undefined {
      const row = db
        .select()
        .from(triggerRuns)
        .where(eq(triggerRuns.sessionId, sessionId))
        .orderBy(desc(triggerRuns.startedAt))
        .limit(1)
        .get();
      return row ? runToDTO(row) : undefined;
    },

    /** Housekeeping: drop stopped non-time triggers older than `before`. */
    deleteStaleDisabled(source: string, before: number): number {
      const res = db
        .delete(triggers)
        .where(
          and(eq(triggers.source, source), eq(triggers.enabled, 0), ne(triggers.updatedAt, 0), lte(triggers.updatedAt, before)),
        )
        .run();
      return res.changes;
    },

    /** Missed-scan support: enabled triggers with a `next_at` in the past. */
    listMissed(now: number): TriggerDTO[] {
      return this.listDue(now);
    },
  };
}

export type TriggerRepo = ReturnType<typeof createTriggerRepo>;
