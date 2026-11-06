/**
 * TriggerScheduler (change: trigger-scheduling).
 *
 * ONE `setTimeout` pointed at the earliest `next_at` — no polling loop.
 * Every wake-up:
 *   1. take due triggers (`next_at <= now`)
 *   2. claim the next slot FIRST (`claimNextAt`, conditional on the old value)
 *      so a concurrent run-now can't double-fire
 *   3. build the event from the row and `dispatch`
 *   4. record `missed` for slots that elapsed while the server was down
 *
 * `PI_TRIGGERS_DISABLED=1` → never armed.
 */

import type { TriggerRepo } from '../../repos/trigger.repo.js';
import type { TriggerDTO } from '@pi-agent-platform/shared-types';
import type { Dispatcher } from './dispatch.js';
import { getTriggerSource } from './sources.js';
import { childLogger } from '../../logger.js';

const logger = childLogger('trigger-scheduler');

/** setTimeout's max delay is 2^31-1 ms (~24.8 days); re-arm above that. */
const MAX_TIMER_MS = 2_147_483_647;
/** Guard against clock jumps / micro-loops. */
const MIN_TIMER_MS = 250;
const HOUSEKEEPING_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface SchedulerDeps {
  triggerRepo: TriggerRepo;
  dispatcher: Dispatcher;
  triggerRuntime: { disabled: boolean };
}

export interface SchedulerHandle {
  start(): void;
  stop(): void;
  /** Re-arm after any create/update/delete (cheap: reads one indexed row). */
  reschedule(): void;
  /** Run one scan immediately (debug / tests). */
  tick(): Promise<void>;
}

export function createScheduler(deps: SchedulerDeps): SchedulerHandle {
  const { triggerRepo, dispatcher, triggerRuntime } = deps;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let lastHousekeepingAt = 0;

  /** Next firing instant for one trigger, per its source. */
  function computeNext(trigger: TriggerDTO, from: number): number | null {
    const spec = getTriggerSource(trigger.source);
    if (!spec?.computeNextAt) return null;
    try {
      return spec.computeNextAt(trigger.config, from);
    } catch (err) {
      logger.warn({ err, triggerId: trigger.id, source: trigger.source }, 'computeNextAt failed; trigger stalled');
      return null;
    }
  }

  /**
   * Record `missed` runs for slots skipped while we were down, then advance
   * `next_at` to the first future slot. No catch-up firing (design D5).
   */
  function catchUp(trigger: TriggerDTO, now: number): void {
    let next = trigger.nextAt;
    let missed = 0;
    const spec = getTriggerSource(trigger.source);
    if (!spec?.computeNextAt) return;
    while (next !== null && next <= now && missed < 1000) {
      missed += 1;
      next = computeNext(trigger, next);
    }
    if (missed > 0) {
      triggerRepo.createRun({
        triggerId: trigger.id,
        status: 'missed',
        triggeredBy: 'schedule',
        startedAt: trigger.nextAt ?? now,
        finishedAt: now,
        error: `missed ${missed} occurrence(s) while server was down`,
      });
      logger.info({ triggerId: trigger.id, missed }, 'recorded missed trigger occurrences');
    }
    if (next !== trigger.nextAt) triggerRepo.update(trigger.id, { nextAt: next });
    // `once`/max_runs收敛 is dispatch's job; a source that has no future slot
    // simply stops being scanned.
    if (next === null) {
      const latest = triggerRepo.get(trigger.id);
      if (latest && latest.maxRuns !== null && latest.runsCount >= latest.maxRuns) {
        triggerRepo.disable(trigger.id);
      }
    }
  }

  async function tick(): Promise<void> {
    if (triggerRuntime.disabled) return;
    const now = Date.now();

    // Housekeeping at most once a day (source-owned cleanup).
    if (now - lastHousekeepingAt > HOUSEKEEPING_INTERVAL_MS) {
      lastHousekeepingAt = now;
      for (const spec of [getTriggerSource('once')]) {
        try {
          spec?.housekeeping?.({
            deleteStaleDisabled: (source, before) => triggerRepo.deleteStaleDisabled(source, before),
          });
        } catch (err) {
          logger.warn({ err, source: spec?.source }, 'source housekeeping failed');
        }
      }
    }

    for (const trigger of triggerRepo.listDue(now)) {
      const expected = trigger.nextAt;
      if (expected === null) continue;
      const next = computeNext(trigger, now);
      // Claim first: only one caller may own this slot.
      const claimed = triggerRepo.claimNextAt(trigger.id, expected, next);
      if (!claimed) {
        logger.debug({ triggerId: trigger.id }, 'slot already claimed elsewhere; skipping');
        continue;
      }
      if (next === null) {
        // No future slot: record why below (missed) and let dispatch converge max_runs.
        if (trigger.runsCount >= (trigger.maxRuns ?? Number.POSITIVE_INFINITY)) {
          triggerRepo.disable(trigger.id);
          continue;
        }
      }
      const event = dispatcher.eventFromTrigger(trigger, {
        triggeredBy: 'schedule',
        firedAt: expected,
      });
      const result = await dispatcher.dispatch(event);
      logger.info({ triggerId: trigger.id, status: result.status, nextAt: next }, 'scheduled trigger fired');
    }
  }

  function arm(): void {
    if (triggerRuntime.disabled) return;
    if (timer) clearTimeout(timer);
    const nextAt = triggerRepo.nextDueAt();
    if (nextAt === null) return;
    const delay = Math.min(Math.max(nextAt - Date.now(), MIN_TIMER_MS), MAX_TIMER_MS);
    timer = setTimeout(() => {
      void run();
    }, delay);
    timer.unref?.();
  }

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      logger.error({ err }, 'scheduler tick failed');
    } finally {
      running = false;
      arm();
    }
  }

  return {
    start() {
      if (triggerRuntime.disabled) {
        logger.warn('trigger scheduler disabled (PI_TRIGGERS_DISABLED=1)');
        return;
      }
      // Sweep runs that never finished before the restart — otherwise the
      // overlap guard would block those triggers forever.
      const stale = triggerRepo.finalizeStaleRuns(Date.now());
      if (stale > 0) logger.warn({ stale }, 'finalized stale trigger runs from a previous process');
      // Missed scan at boot: catch-up bookkeeping for every enabled trigger.
      const now = Date.now();
      for (const trigger of triggerRepo.listDue(now)) catchUp(trigger, now);
      arm();
      logger.info({ nextAt: triggerRepo.nextDueAt() }, 'trigger scheduler armed');
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    reschedule: arm,
    tick,
  };
}
