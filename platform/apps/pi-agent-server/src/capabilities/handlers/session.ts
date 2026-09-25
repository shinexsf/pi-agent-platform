/**
 * session.* capabilities — list / get / update / restart.
 *
 * Effect-timing split (spec: session.update):
 *   model / thinkingLevel → immediate (IPC + DB double-write; DB only when worker dead)
 *   title                 → shared renameSession semantics (session-ops.ts)
 *   config.*              → DB only; takes effect on next spawn (full-snapshot semantics)
 *
 * restart: graceful kill + immediate respawn reusing piSessionPath. The sessions
 * row and the IM session-channel map (master memory, worker-independent) are
 * untouched — "reopen & reload" without breaking channel wiring.
 */

import type { AnyCapabilityDef, CapabilityDef, SessionDTO } from '@pi-agent-platform/shared-types';
import type { AgentRepo } from '../../repos/agent.repo.js';
import type { SessionRepo } from '../../repos/session.repo.js';
import type { WorkerPool } from '../../worker-pool.js';
import { renameSession } from '../../services/session-ops.js';
import { spawnAndCreate } from '../../im-gateway/session-bridge.js';

function notFound(id: string): Error {
  const e = new Error(`Session not found: ${id}`);
  e.name = 'NotFoundError';
  return e;
}

function withWorker(s: SessionDTO, workerPool: WorkerPool): SessionDTO & { workerAlive: boolean } {
  return { ...s, workerAlive: workerPool.has(s.id) };
}

export function sessionCapabilities(
  agentRepo: AgentRepo,
  sessionRepo: SessionRepo,
  workerPool: WorkerPool,
): AnyCapabilityDef[] {
  const list: CapabilityDef<{ agentId?: string; title?: string; status?: string }, unknown> = {
    method: 'session.list',
    module: 'session',
    access: 'read',
    scoped: false,
    summary: '搜索 sessions：agentId 精确 + title 模糊子串 + status(active|archived) 过滤（AND 关系）',
    paramsSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '精确匹配' },
        title: { type: 'string', description: 'title 子串（不区分大小写）' },
        status: { type: 'string', enum: ['active', 'archived'] },
      },
      additionalProperties: false,
    },
    returns: 'SessionDTO 数组（含 config 与 workerAlive 运行态）',
    handler: (ctx, params) => {
      void ctx;
      let rows = sessionRepo.list(params?.agentId);
      if (params?.title) {
        const q = params.title.toLowerCase();
        rows = rows.filter((s) => (s.title ?? '').toLowerCase().includes(q));
      }
      if (params?.status) rows = rows.filter((s) => s.status === params.status);
      return { sessions: rows.map((s) => withWorker(s, workerPool)), total: rows.length };
    },
  };

  const get: CapabilityDef<{ id: string }, unknown> = {
    method: 'session.get',
    module: 'session',
    access: 'read',
    scoped: true, // own-mode: id must belong to the caller's own agent
    summary: '按 id 取 session 完整详情（含 config、worker 运行态）',
    paramsSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    returns: '完整 SessionDTO + workerAlive；不存在 → "Session not found: <id>"',
    handler: (ctx, params) => {
      void ctx;
      const s = sessionRepo.get(params.id);
      if (!s) throw notFound(params.id);
      return withWorker(s, workerPool);
    },
  };

  const update: CapabilityDef<{ id: string; patch: Partial<Pick<SessionDTO, 'title' | 'model' | 'thinkingLevel' | 'config'>> }, unknown> = {
    method: 'session.update',
    module: 'session',
    access: 'write',
    scoped: true, // own-mode: session must belong to the caller's own agent
    summary:
      '局部更新 session：model/thinkingLevel 即时生效（IPC+DB）、title 走改名同步、config.* 仅写 DB 下次 spawn 生效',
    paramsSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        patch: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '1-200 字符；空串=清空' },
            model: { type: 'string', description: 'provider/modelId（worker 存活时立即切换）' },
            thinkingLevel: { type: 'string', enum: ['off', 'low', 'medium', 'high'] },
            config: { type: 'object', description: 'AgentConfig 整体替换；⚠️ 下次 spawn 生效' },
          },
          additionalProperties: false,
        },
      },
      required: ['id', 'patch'],
      additionalProperties: false,
    },
    returns:
      '更新后的 SessionDTO。生效时机：model/thinkingLevel=即时（worker 存活时；死则下次 spawn）、title=即时（pi 同步回流）、config.*=⚠️ 下次 spawn 生效（想立即生效配合 session.restart）',
    handler: async (ctx, params) => {
      void ctx;
      const existing = sessionRepo.get(params.id);
      if (!existing) throw notFound(params.id);
      const patch = params.patch ?? {};

      // title → shared rename semantics (single implementation with HTTP routes)
      if (patch.title !== undefined) {
        const t = patch.title.trim();
        if (t.length > 200) throw new Error('Title too long (max 200 chars)');
        await renameSession({ sessionRepo, workerPool }, params.id, t || undefined);
      }

      // model → immediate when worker alive (IPC + entry cache + DB), DB-only otherwise
      if (patch.model !== undefined) {
        const slashIdx = patch.model.indexOf('/');
        if (slashIdx <= 0 || !patch.model.slice(slashIdx + 1)) {
          throw new Error(`Invalid model format (expected provider/modelId): ${patch.model}`);
        }
        if (workerPool.has(params.id)) {
          const provider = patch.model.slice(0, slashIdx);
          const modelId = patch.model.slice(slashIdx + 1);
          await workerPool.call(params.id, 'setModel', [provider, modelId]);
          workerPool.setModel(params.id, { provider, modelId });
        }
        sessionRepo.update(params.id, { model: patch.model });
      }

      // thinkingLevel → immediate when worker alive; persisted to sessions row (PATCH semantics)
      if (patch.thinkingLevel !== undefined) {
        const VALID = ['off', 'low', 'medium', 'high'];
        if (!VALID.includes(patch.thinkingLevel)) {
          throw new Error(`Invalid thinkingLevel (must be one of ${VALID.join(', ')})`);
        }
        if (workerPool.has(params.id)) {
          await workerPool.call(params.id, 'setThinkingLevel', [patch.thinkingLevel]);
          workerPool.setThinkingLevel(params.id, patch.thinkingLevel as 'off' | 'low' | 'medium' | 'high');
        }
        sessionRepo.update(params.id, { thinkingLevel: patch.thinkingLevel || undefined });
      }

      // config.* → DB only (full-snapshot: next spawn picks it up)
      if (patch.config !== undefined) {
        sessionRepo.update(params.id, { config: patch.config });
      }

      return withWorker(sessionRepo.get(params.id)!, workerPool);
    },
  };

  const restart: CapabilityDef<{ id: string }, unknown> = {
    method: 'session.restart',
    module: 'session',
    access: 'write',
    scoped: true, // own-mode: session must belong to the caller's own agent
    summary:
      '重启 session worker：优雅 kill 后立即重建并复用历史（重新打开并加载）。sessions 行与 IM/Web 渠道映射不受影响。用于让 config.* 修改立即生效',
    paramsSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    returns:
      '{ restarted: true, workerPid, historyRestored } — 渠道映射（session-channel-map）与 sessions 行不变；⚠️ 正在执行的 turn 会被中断',
    handler: async (ctx, params) => {
      void ctx;
      const existing = sessionRepo.get(params.id);
      if (!existing) throw notFound(params.id); // placeholder (no row) → 404 per spec
      const agent = agentRepo.get(existing.agentId);
      if (!agent) throw new Error(`Agent not found for session: ${existing.agentId}`);

      // busy check: in-flight master→worker calls ⇒ a turn is running → refuse
      const entry = workerPool.get(params.id);
      if (entry && entry.pendingCalls.size > 0) {
        throw new Error('Session busy (turn in progress) — retry later');
      }

      if (workerPool.has(params.id)) {
        await workerPool.kill(params.id, 'capability-restart');
      }
      // Respawn reusing the pi session file — history restored, config re-snapshotted
      // from the sessions row. Row itself and channel map are NOT touched here.
      await spawnAndCreate(params.id, agent, sessionRepo, workerPool, existing.piSessionPath);
      const newEntry = workerPool.get(params.id);
      return {
        restarted: true,
        workerPid: newEntry?.workerPid ?? -1,
        historyRestored: true,
      };
    },
  };

  return [list, get, update, restart];
}
