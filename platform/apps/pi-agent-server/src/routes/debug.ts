/**
 * Debug routes — dev-only, loaded via **dynamic import** in index.ts so
 * production (NODE_ENV=production) never loads this module — including
 * /debug/db (raw SQL, agent self-testing tool).
 * Provides internal-state observation for self-testing.
 */

import { Hono } from 'hono';
import { config } from '../config.js';
import type { WorkerPool } from '../worker-pool.js';
import type { SessionRepo } from '../repos/session.repo.js';
import { sql } from 'drizzle-orm';
import type { DB } from '../db/init.js';

export function createDebugRouter(
  workerPool: WorkerPool,
  sessionRepo: SessionRepo,
  db: DB,
) {
  const router = new Hono();

  router.get('/health', (c) => {
    return c.json({
      uptime: process.uptime(),
      isDev: config.isDev,
      activeSessions: sessionRepo.list('__none__').length, // approximation
      activeWorkers: workerPool.list().length,
    });
  });

  router.get('/sessions', (c) => {
    const workers = workerPool.list();
    const sessions = sessionRepo.list();
    return c.json({ sessions, workers });
  });

  router.get('/sessions/:id', (c) => {
    const id = c.req.param('id');
    const session = sessionRepo.get(id);
    const worker = workerPool.get(id);
    return c.json({ session, worker: worker ? { workerPid: worker.workerPid, ready: worker.ready, stderrTail: worker.stderrTail, pendingCalls: worker.pendingCalls.size } : null });
  });

  router.get('/workers', (c) => {
    return c.json({ workers: workerPool.list() });
  });

  // Direct SQL execution (dev only — not for prod)
  router.get('/db', (c) => {
    const query = c.req.query('sql');
    if (!query) return c.json({ error: 'Missing sql query param' }, 400);
    try {
      const result = db.all(sql.raw(query));
      return c.json({ rows: result });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  return router;
}