/**
 * Trigger runtime composition root (change: trigger-scheduling).
 *
 * Wires the built-in sources, the dispatcher, the notifier and the scheduler
 * into one handle that routes / capabilities / plugin extensions share through
 * a module singleton (same style as `sessionRegistry`).
 */

import type { AgentRepo } from '../../repos/agent.repo.js';
import type { SessionRepo } from '../../repos/session.repo.js';
import type { TriggerRepo } from '../../repos/trigger.repo.js';
import type { NotificationRepo } from '../../repos/notification.repo.js';
import type { WorkerPool } from '../../worker-pool.js';
import { createNotifier, type Notifier } from '../notifier.js';
import { createDispatcher, type Dispatcher } from './dispatch.js';
import { createScheduler, type SchedulerHandle } from './scheduler.js';
import { listTriggerSources, registerTriggerSource } from './sources.js';
import { cronSource } from './sources/cron.js';
import { onceSource } from './sources/once.js';
import { webhookSource } from './sources/webhook.js';
import { childLogger } from '../../logger.js';

const logger = childLogger('trigger-runtime');

export interface TriggerRuntime {
  repo: TriggerRepo;
  /** Needed by session-binding validation (reuse targets own agent's sessions). */
  sessionRepo: SessionRepo;
  notificationRepo: NotificationRepo;
  notifier: Notifier;
  dispatcher: Dispatcher;
  scheduler: SchedulerHandle;
  /** Shared mutable flag — `PI_TRIGGERS_DISABLED=1` flips it once. */
  flags: { disabled: boolean };
}

let runtime: TriggerRuntime | undefined;

export interface InitTriggersDeps {
  agentRepo: AgentRepo;
  sessionRepo: SessionRepo;
  triggerRepo: TriggerRepo;
  notificationRepo: NotificationRepo;
  workerPool: WorkerPool;
  notificationsConfigPath: string;
  triggersDisabled: boolean;
}

export function initTriggerRuntime(deps: InitTriggersDeps): TriggerRuntime {
  // Built-in sources register through the SAME registry plugins use (no special case).
  for (const spec of [cronSource, onceSource, webhookSource]) {
    try {
      registerTriggerSource(spec);
    } catch (err) {
      logger.warn({ err, source: spec.source }, 'built-in source registration skipped');
    }
  }

  const flags = { disabled: deps.triggersDisabled };
  const notifier = createNotifier({
    notificationRepo: deps.notificationRepo,
    notificationsConfigPath: deps.notificationsConfigPath,
  });
  const dispatcher = createDispatcher({
    agentRepo: deps.agentRepo,
    sessionRepo: deps.sessionRepo,
    triggerRepo: deps.triggerRepo,
    workerPool: deps.workerPool,
    notifier,
    triggerRuntime: flags,
  });
  const scheduler = createScheduler({
    triggerRepo: deps.triggerRepo,
    dispatcher,
    triggerRuntime: flags,
  });

  runtime = {
    repo: deps.triggerRepo,
    sessionRepo: deps.sessionRepo,
    notificationRepo: deps.notificationRepo,
    notifier,
    dispatcher,
    scheduler,
    flags,
  };
  logger.info(
    { sources: listTriggerSources().map((s) => s.source), disabled: flags.disabled },
    'trigger runtime ready',
  );
  return runtime;
}

export function triggerRuntime(): TriggerRuntime {
  if (!runtime) throw new Error('triggerRuntime() called before initTriggerRuntime()');
  return runtime;
}

export function hasTriggerRuntime(): boolean {
  return runtime !== undefined;
}
