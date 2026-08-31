import { Hono } from 'hono';
import fs from 'node:fs/promises';
import type { AgentRepo } from '../repos/agent.repo.js';
import type { SessionRepo } from '../repos/session.repo.js';
import type { WorkerPool } from '../worker-pool.js';
import type { AttachmentStore } from '../services/attachment-store.js';
import type { CreateAgentRequest, UpdateAgentRequest } from '@pi-agent-platform/api-types';
import { normalizePath } from '../utils/normalize-path.js';

/**
 * Sessions are children of their agent — when an agent is removed, every
 * session row + pi session file belonging to it must go too (cascade delete).
 *
 * The `deleteAgentCascade` helper centralizes this so the route handler stays
 * short. Caller responsibilities:
 *   1. Kills any live worker for each session (otherwise the worker keeps
 *      appending to the file we're about to unlink).
 *   2. Unlinks the pi session file (ENOENT is silently OK).
 *   3. Deletes the DB row.
 *
 * Returns `{ deleted: number, errors: string[] }` so the route can surface
 * partial failures (e.g. file already gone but row existed).
 */
async function deleteAgentCascade(
  agentId: string,
  sessionRepo: SessionRepo,
  workerPool: WorkerPool,
  attachmentStore: AttachmentStore,
): Promise<{ deleted: number; errors: string[]; attachmentsDeleted: number }> {
  const sessions = sessionRepo.list(agentId);
  let deleted = 0;
  let attachmentsDeleted = 0;
  const errors: string[] = [];
  for (const session of sessions) {
    if (workerPool.has(session.id)) {
      try {
        await workerPool.kill(session.id, 'agent-deleted');
      } catch (e) {
        errors.push(`kill worker ${session.id}: ${(e as Error).message}`);
        // continue — file + row cleanup may still succeed
      }
    }
    // Cascade attachments BEFORE the pi session file. attachmentStore owns
    // its per-session subdirectory; the session file unlink below is for the
    // session file itself (with read-tool images embedded as base64).
    try {
      const { rowsDeleted } = await attachmentStore.deleteBySession(session.id);
      attachmentsDeleted += rowsDeleted;
    } catch (e) {
      errors.push(`attachments cascade ${session.id}: ${(e as Error).message}`);
    }
    try {
      await fs.unlink(session.piSessionPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        errors.push(`unlink ${session.piSessionPath}: ${(err as Error).message}`);
      }
    }
    const removed = sessionRepo.delete(session.id);
    if (removed) deleted++;
  }
  return { deleted, errors, attachmentsDeleted }
}

export function createAgentsRouter(
  agentRepo: AgentRepo,
  sessionRepo: SessionRepo,
  workerPool: WorkerPool,
  attachmentStore: AttachmentStore,
) {
  const router = new Hono();

  // GET /api/agents?workspacePath=...
  // When workspacePath is provided, return only agents whose stored workspacePath
  // matches (exact, after normalize). Server normalizes the query so callers
  // (IDE plugin, webui) don't need to. Without workspacePath, returns all.
  router.get('/', (c) => {
    const workspacePath = c.req.query('workspacePath');
    if (workspacePath) {
      return c.json(agentRepo.list({ workspacePath: normalizePath(workspacePath) }));
    }
    return c.json(agentRepo.list());
  });

  // GET /api/agents/:id
  router.get('/:id', (c) => {
    const id = c.req.param('id');
    const agent = agentRepo.get(id);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);
    return c.json(agent);
  });

  // POST /api/agents
  router.post('/', async (c) => {
    const body = (await c.req.json()) as CreateAgentRequest;
    // Only name / workspacePath / model are strictly required. systemPrompt and
    // tools are optional — absent means "use pi defaults" (handled in worker +
    // repo by storing NULL / omitting from createAgentSession options).
    if (!body.name || !body.workspacePath || !body.model) {
      return c.json({ error: 'Missing required fields: name, workspacePath, model' }, 400);
    }
    const created = agentRepo.create(body);
    return c.json(created, 201);
  });

  // POST /api/agents/:id
  router.post('/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as UpdateAgentRequest;
    const updated = agentRepo.update(id, body);
    if (!updated) return c.json({ error: 'Agent not found' }, 404);
    return c.json(updated);
  });

  // POST /api/agents/:id/delete — cascade: kills every session worker,
  // unlinks every pi session file, removes every session row, then deletes
  // the agent row itself. Also cascades user-attachment storage.
  router.post('/:id/delete', async (c) => {
    const id = c.req.param('id');
    const ok = agentRepo.delete(id);
    if (!ok) return c.json({ error: 'Agent not found' }, 404);
    const cascade = await deleteAgentCascade(id, sessionRepo, workerPool, attachmentStore);
    return c.json({ ok: true, cascade });
  });

  return router;
}