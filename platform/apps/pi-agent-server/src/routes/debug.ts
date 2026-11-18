/**
 * Debug routes — dev-only, loaded via **dynamic import** in index.ts so
 * production (NODE_ENV=production) never loads this module — including
 * /debug/db (raw SQL, agent self-testing tool).
 * Provides internal-state observation for self-testing.
 */

import { Hono } from 'hono';
import { config } from '../config.js';
import type { WorkerPool } from '@pi-agent-platform/core';
import type { SessionRepo } from '@pi-agent-platform/core';
import { sql } from 'drizzle-orm';
import type { DB } from '@pi-agent-platform/core/db';
import type { AgentRepo } from '@pi-agent-platform/core';

/** Keep webhook secrets out of debug output (末尾 4 位足够排查)。 */
function redactSecretConfig(config: Record<string, unknown>): Record<string, unknown> {
  const secret = config?.secret;
  if (typeof secret !== 'string') return config;
  return { ...config, secret: undefined, secretEnding: secret.slice(-4) };
}
import { extractExtensionNames, readSettings } from '@pi-agent-platform/core';
import { getPluginSnapshot, resolveSessionPlugins } from '@pi-agent-platform/core';

export function createDebugRouter(
  workerPool: WorkerPool,
  sessionRepo: SessionRepo,
  db: DB,
  agentRepo?: AgentRepo,
) {
  const router = new Hono();

  return router;
}