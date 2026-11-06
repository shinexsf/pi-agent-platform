/**
 * dispatch — the core execution path for a resolved `TriggerEvent`
 * (change: trigger-scheduling, design D3).
 *
 * Two layers only:
 *   adapter  → reads the trigger row (by id or by secret) and builds a
 *              `TriggerEvent` carrying `target` + `instruction`
 *   dispatch → guards, resolves the session from `event.target`, builds the
 *              `<system-event>` envelope, prompts, records the run, converges
 *              `max_runs`, notifies on failure
 *
 * `dispatch` MUST NOT re-read the trigger to decide *where* to execute, and
 * MUST NOT branch on `source`.
 */

import type { AgentRepo } from '../../repos/agent.repo.js';
import type { SessionRepo } from '../../repos/session.repo.js';
import type { TriggerRepo } from '../../repos/trigger.repo.js';
import type { WorkerPool } from '../../worker-pool.js';
import type { Notifier } from '../notifier.js';
import type { TriggerDTO, TriggerEvent } from '@pi-agent-platform/shared-types';
import { sessionRegistry } from '../session.js';
import { buildTriggerEnvelope } from '../system-envelope.js';
import { childLogger } from '../../logger.js';

const logger = childLogger('trigger-dispatch');

/** Idempotency window: same trigger + same key inside 24h is a duplicate. */
const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type DispatchStatus = 'dispatched' | 'skipped' | 'duplicate' | 'disabled' | 'failed';

export interface DispatchResult {
  status: DispatchStatus;
  runId?: string;
  sessionId?: string;
  error?: string;
}

export interface DispatcherDeps {
  agentRepo: AgentRepo;
  sessionRepo: SessionRepo;
  triggerRepo: TriggerRepo;
  workerPool: WorkerPool;
  notifier: Notifier;
  /** `PI_TRIGGERS_DISABLED=1` — global kill switch. */
  triggerRuntime: { disabled: boolean };
}

export interface Dispatcher {
  dispatch(event: TriggerEvent): Promise<DispatchResult>;
  /** Build a `TriggerEvent` from a trigger row (the adapter half, shared by
   *  scheduler / run-now / capability / plugin calls). */
  eventFromTrigger(
    trigger: TriggerDTO,
    opts: {
      triggeredBy: TriggerEvent['triggeredBy'];
      firedAt?: number;
      payload?: unknown;
      idempotencyKey?: string;
      meta?: Record<string, string>;
    },
  ): TriggerEvent;
}

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { agentRepo, sessionRepo, triggerRepo, workerPool, notifier, triggerRuntime } = deps;

  function eventFromTrigger(
    trigger: TriggerDTO,
    opts: {
      triggeredBy: TriggerEvent['triggeredBy'];
      firedAt?: number;
      payload?: unknown;
      idempotencyKey?: string;
      meta?: Record<string, string>;
    },
  ): TriggerEvent {
    return {
      triggerId: trigger.id,
      target: {
        agentId: trigger.agentId,
        sessionMode: trigger.sessionMode,
        ...(trigger.sessionMode === 'reuse' && trigger.sessionId ? { sessionId: trigger.sessionId } : {}),
      },
      instruction: trigger.prompt,
      source: trigger.source,
      firedAt: opts.firedAt ?? Date.now(),
      payload: opts.payload,
      triggeredBy: opts.triggeredBy,
      ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      ...(opts.meta ? { meta: opts.meta } : {}),
    };
  }

  /** Resolve (or create) the execution session from `event.target`. */
  async function resolveSession(
    event: TriggerEvent,
    trigger: TriggerDTO,
  ): Promise<{ sessionId: string; created: boolean }> {
    const registry = sessionRegistry();
    const agent = agentRepo.get(event.target.agentId);
    if (!agent) throw new Error(`agent not found: ${event.target.agentId}`);

    let sessionId: string;
    let created = false;
    if (event.target.sessionMode === 'reuse' && event.target.sessionId) {
      // Lazy revival: idle-killed workers come back via getOrCreate.
      sessionId = event.target.sessionId;
    } else {
      const session = await registry.createFromAgent(event.target.agentId);
      sessionId = session.id;
      created = true;
    }
    // Persist the row (placeholder activation) / revive an existing one.
    await registry.getOrCreate(sessionId, agent);

    if (created) {
      // Attribution without touching the sessions schema: title prefix.
      const title = trigger.name ? `[${trigger.name}]` : '';
      if (title) sessionRepo.update(sessionId, { title });
      if (event.target.sessionMode === 'reuse') {
        triggerRepo.update(trigger.id, { sessionId });
      }
    }
    return { sessionId, created };
  }

  async function execute(event: TriggerEvent, trigger: TriggerDTO): Promise<DispatchResult> {
    const runId = triggerRepo.createRun({
      triggerId: trigger.id,
      status: 'fired',
      triggeredBy: event.triggeredBy,
      idempotencyKey: event.idempotencyKey ?? null,
      startedAt: Date.now(),
      payloadBytes: event.payload === undefined ? null : Buffer.byteLength(JSON.stringify(event.payload) ?? ''),
    });

    try {
      const { sessionId } = await resolveSession(event, trigger);
      const envelope = buildTriggerEnvelope({
        name: trigger.name,
        source: event.source,
        firedAt: event.firedAt,
        runId,
        instruction: event.instruction,
        payload: event.payload,
      });
      await workerPool.call(sessionId, 'prompt', [envelope, {}]);

      triggerRepo.finishRun(runId, { status: 'fired', sessionId, finishedAt: Date.now() });
      const runsCount = trigger.runsCount + 1;
      triggerRepo.update(trigger.id, {
        runsCount,
        lastFiredAt: Date.now(),
        ...(event.target.sessionMode === 'reuse' && !trigger.sessionId ? { sessionId } : {}),
      });
      // Generic convergence (no per-source hook): once/max_runs triggers stop here.
      if (trigger.maxRuns !== null && runsCount >= trigger.maxRuns) {
        triggerRepo.disable(trigger.id);
        logger.info({ triggerId: trigger.id, runsCount, maxRuns: trigger.maxRuns }, 'trigger reached max_runs; disabled');
      }
      logger.info(
        { triggerId: trigger.id, runId, sessionId, triggeredBy: event.triggeredBy },
        'trigger dispatched',
      );
      return { status: 'dispatched', runId, sessionId };
    } catch (err) {
      const message = (err as Error).message;
      triggerRepo.finishRun(runId, { status: 'failed', error: message, finishedAt: Date.now() });
      logger.warn({ err, triggerId: trigger.id, runId }, 'trigger dispatch failed');
      await notifier
        .notify({
          severity: 'error',
          title: `触发器「${trigger.name}」执行失败`,
          body: message,
          source: 'trigger',
          sourceId: trigger.id,
          actionUrl: `/triggers/${trigger.id}`,
        })
        .catch((notifyErr) => logger.warn({ err: notifyErr }, 'failure notification dropped'));
      return { status: 'failed', runId, error: message };
    }
  }

  return {
    eventFromTrigger,

    async dispatch(event: TriggerEvent): Promise<DispatchResult> {
      if (triggerRuntime.disabled) {
        logger.warn({ triggerId: event.triggerId }, 'dispatch rejected: PI_TRIGGERS_DISABLED=1');
        return { status: 'disabled' };
      }

      const trigger = triggerRepo.get(event.triggerId);
      if (!trigger) {
        // Adapters resolve the row first, so a missing row means it was deleted
        // between resolve and dispatch — drop quietly, no run row for a ghost.
        logger.warn({ triggerId: event.triggerId }, 'dispatch dropped: trigger no longer exists');
        return { status: 'disabled', error: 'trigger not found' };
      }
      if (!trigger.enabled) {
        triggerRepo.createRun({
          triggerId: trigger.id,
          status: 'skipped',
          triggeredBy: event.triggeredBy,
          error: 'disabled',
          finishedAt: Date.now(),
        });
        return { status: 'disabled' };
      }

      if (event.idempotencyKey) {
        const since = Date.now() - IDEMPOTENCY_WINDOW_MS;
        if (triggerRepo.hasRecentIdempotencyKey(trigger.id, event.idempotencyKey, since)) {
          triggerRepo.createRun({
            triggerId: trigger.id,
            status: 'skipped',
            triggeredBy: event.triggeredBy,
            idempotencyKey: event.idempotencyKey,
            error: 'duplicate',
            finishedAt: Date.now(),
          });
          return { status: 'duplicate' };
        }
      }

      if (triggerRepo.hasRunningRun(trigger.id)) {
        triggerRepo.createRun({
          triggerId: trigger.id,
          status: 'skipped',
          triggeredBy: event.triggeredBy,
          error: 'overlap',
          finishedAt: Date.now(),
        });
        logger.info({ triggerId: trigger.id }, 'trigger skipped: previous run still running');
        return { status: 'skipped', error: 'overlap' };
      }

      return execute(event, trigger);
    },
  };
}
