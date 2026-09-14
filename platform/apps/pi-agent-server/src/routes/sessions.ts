/**
 * Sessions REST routes (CRUD + prompt + archive + history + placeholder).
 *
 * Two-phase session creation (per architecture):
 * 1. POST /api/sessions/agents/:agentId — placeholder, returns sessionId only (no DB write)
 * 2. POST /api/sessions/:id/prompt — actual INSERT + worker createSession + prompt
 *
 * History (GET /api/sessions/:id/messages) reads pi_session_path file directly — master does NOT
 * need worker alive for history queries.
 */

import { Hono } from 'hono';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AgentRepo } from '../repos/agent.repo.js';
import type { SessionRepo } from '../repos/session.repo.js';
import type { WorkerPool } from '../worker-pool.js';
import type { AttachmentStore } from '../services/attachment-store.js';
import type { PromptRequest, PlaceholderSessionResponse, SlashCommandDTO, ModelInfo } from '@pi-agent-platform/api-types';
import type { RuntimeConfig, AgentConfig } from '@pi-agent-platform/shared-types';
import { listAvailableModels } from '../model-registry.js';
import { normalizePath } from '../utils/normalize-path.js';

export function createSessionsRouter(
  agentRepo: AgentRepo,
  sessionRepo: SessionRepo,
  workerPool: WorkerPool,
  attachmentStore: AttachmentStore,
) {
  const router = new Hono();

  // GET /api/sessions?agent_id=&workspacePath=&search=&page=&pageSize=
  // workspacePath filter joins agents table; see session.repo for rationale.
  router.get('/', (c) => {
    const agentId = c.req.query('agent_id');
    const workspacePathRaw = c.req.query('workspacePath');
    const workspacePath = workspacePathRaw ? normalizePath(workspacePathRaw) : undefined;
    const search = c.req.query('search') ?? undefined;
    const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
    const pageSizeRaw = Number.parseInt(c.req.query('pageSize') ?? '20', 10);
    const pageSize = Math.min(100, Math.max(1, pageSizeRaw || 20));
    const offset = (page - 1) * pageSize;
    const { sessions: rows, total } = sessionRepo.listPaged({
      agentId,
      workspacePath,
      search,
      offset,
      limit: pageSize,
    });
    const list = rows.map((s) => {
        // Attach live thinkingLevel from worker pool (DB doesn't persist it — OQ-D2).
        // Worker pool is the authority for the runtime value.
        const entry = workerPool.get(s.id);
        const thinkingLevel = entry?.thinkingLevel ?? s.thinkingLevel ?? null;
        return { ...s, worker: workerPool.toSummary(s.id), thinkingLevel };
      });
      return c.json({ sessions: list, total, page, pageSize });
  });

  // GET /api/sessions/:id
  router.get('/:id', (c) => {
    const id = c.req.param('id');
    const session = sessionRepo.get(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    const agent = agentRepo.get(session.agentId);
    return c.json({ ...session, agentName: agent?.name ?? null, worker: workerPool.toSummary(id) });
  });

  // GET /api/sessions/:id/context — unified context endpoint.
  // Returns commands + models + session row in one fetch. Replaces the old
  // GET /:id/commands, GET /api/models, GET /:id (for IDE context).
  //
  // Cases:
  //   1. Worker alive: serve commands + models from worker, attach session row (or null).
  //   2a. Worker dead + session row exists: respawn worker synchronously, then case 1.
  //   2b. Worker dead + placeholder (no row): skip rebuild, return empty commands.
  router.get('/:id/context', async (c) => {
    const id = c.req.param('id');
    const session = sessionRepo.get(id) ?? null;

    // Case 2a: existing session row but worker dead — rebuild synchronously
    if (session && !workerPool.has(id)) {
      const agent = agentRepo.get(session.agentId);
      if (!agent) return c.json({ error: 'Agent not found' }, 404);
      await spawnAndCreate(id, agent, sessionRepo, workerPool, session.piSessionPath);
    }

    if (workerPool.has(id)) {
      const [commands, models, contextUsage] = await Promise.all([
        workerPool.call<SlashCommandDTO[]>(id, 'listCommands', []),
        workerPool.call<ModelInfo[]>(id, 'listAvailableModels', []),
        workerPool.call<{ tokens: number | null; contextWindow: number; percent: number | null } | null>(id, 'getContextUsage', []),
      ]);
      const entry = workerPool.get(id);
      return c.json({
        sessionId: id,
        hasRow: !!session,
        session,
        commands,
        models,
        currentModel: computeCurrentModel(session, entry?.model),
        currentThinkingLevel: computeCurrentThinkingLevel(session, entry?.thinkingLevel),
        contextUsage: contextUsage ?? null,
        // Cached at createSession time (see cacheSystemPrompt in spawnPlaceholder
        // / spawnAndCreate). Avoids re-fetching the full system prompt string
        // over IPC on every context call.
        systemPrompt: entry?.systemPrompt ?? null,
      });
    }

    // Case 2b: placeholder with no worker (placeholder worker was timed out or LRU-evicted)
    return c.json({
      sessionId: id,
      hasRow: !!session,
      session,
      commands: [],
      models: await listAvailableModels(),
      currentModel: computeCurrentModel(session, null),
      currentThinkingLevel: computeCurrentThinkingLevel(session, null),
      contextUsage: null,
    });
  });

  // GET /api/sessions/:id/messages (history — master reads file directly)
  router.get('/:id/messages', async (c) => {
    const id = c.req.param('id');
    const session = sessionRepo.get(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);

    try {
      const content = await fs.readFile(session.piSessionPath, 'utf8');
      const lines = content.split('\n').filter((l) => l.trim());

      const messages: Array<{
        id: string;
        parentId?: string;
        role: 'user' | 'assistant' | 'toolResult';
        content: string;
        thinking?: string;
        toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown>; result?: string; isError?: boolean; images?: Array<{ mimeType: string; data: string }> }>;
        toolCallId?: string;
        toolName?: string;
        model?: string;
        provider?: string;
        stopReason?: string;
        isError?: boolean;
        images?: Array<{ mimeType: string; data: string }>;
        timestamp: number;
      }> = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as {
            type?: string;
            id?: string;
            parentId?: string;
            timestamp?: string | number;
            message?: {
              role?: string;
              content?: Array<{
                type?: string;
                text?: string;
                thinking?: string;
                id?: string;
                name?: string;
                arguments?: unknown;
                toolCallId?: string;
                content?: Array<{ type?: string; text?: string }> | string;
                isError?: boolean;
                /** Image block: base64 data + mimeType (user-pasted OR read-tool). */
                data?: string;
                mimeType?: string;
              }> | string;
              timestamp?: number;
              model?: string;
              provider?: string;
              stopReason?: string;
              toolCallId?: string;
              toolName?: string;
              isError?: boolean;
            };
          };
          if (entry.type !== 'message' || !entry.message) continue;

          const msg = entry.message;
          const role: 'user' | 'assistant' | 'toolResult' =
            msg.role === 'user' || msg.role === 'assistant' || msg.role === 'toolResult'
              ? msg.role
              : 'assistant';

          let content = '';
          let thinking: string | undefined;
          let toolCalls: Array<{ id: string; name: string; args: Record<string, unknown>; result?: string; isError?: boolean }> | undefined;
          let images: Array<{ mimeType: string; data: string }> | undefined;

          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'text' && typeof block.text === 'string') {
                content += block.text;
              } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
                thinking = (thinking ?? '') + block.thinking;
              } else if (block.type === 'toolCall' && block.id && block.name) {
                toolCalls = toolCalls ?? [];
                toolCalls.push({
                  id: block.id,
                  name: block.name,
                  args: (block.arguments as Record<string, unknown> | undefined) ?? {},
                });
              } else if (
                block.type === 'image'
                && typeof block.data === 'string'
                && typeof block.mimeType === 'string'
              ) {
                // Image block: includes user-pasted images (post-PI-PR) AND read-tool
                // images. Both ride into MessageDTO.images so IDE renders them in
                // history view via <ImageGrid>. We do NOT distinguish origin here.
                images = images ?? [];
                images.push({ mimeType: block.mimeType, data: block.data });
              }
            }
          } else if (typeof msg.content === 'string') {
            content = msg.content;
          }

          // Tool result: pi SDK encodes as role:'toolResult' with the result
          // text directly inside `content` as text blocks (e.g.
          // `[{ type: "text", text: "..." }]`). Previously this branch looked
          // for `block.type === 'toolResult'` and a nested `block.content`
          // array — but pi SDK toolResult messages don't wrap content that
          // way (the conformance test in
          // `@earendil-works/pi-agent-core/dist/.../conformance.d.ts` shows
          // the actual shape). The outer check never matched, leaving
          // toolResult content empty in the IDE history view.
          // Fix: just walk the text blocks in `msg.content` (same loop as the
          // assistant/user branches above). We also pick up `isError` here
          // (top-level field on the toolResult message) so the IDE can
          // distinguish completed from failed on history replay.
          let toolCallId: string | undefined;
          let toolName: string | undefined;
          let isError: boolean | undefined;
          if (role === 'toolResult') {
            toolCallId = msg.toolCallId;
            toolName = msg.toolName;
            isError = typeof msg.isError === 'boolean' ? msg.isError : undefined;
            // msg.content was already walked above (text blocks → `content`),
            // so no second pass needed. The previous nested `block.type ===
            // 'toolResult'` check is dead code; the unconditional text-block
            // loop above already populated `content` for toolResult.
          }

          let ts = 0;
          if (typeof entry.timestamp === 'number') ts = entry.timestamp;
          else if (typeof entry.timestamp === 'string') {
            const parsed = Date.parse(entry.timestamp);
            if (!Number.isNaN(parsed)) ts = parsed;
          }
          if (ts === 0 && typeof msg.timestamp === 'number') ts = msg.timestamp;

          messages.push({
            id: entry.id ?? `msg-${messages.length}`,
            parentId: entry.parentId ?? undefined,
            role,
            content,
            thinking,
            toolCalls,
            toolCallId,
            toolName,
            model: msg.model ?? undefined,
            provider: msg.provider ?? undefined,
            stopReason: msg.stopReason ?? undefined,
            isError,
            // Image blocks (user-pasted or read-tool) ride along as base64.
            // Only emit the field when present (avoid pollution for messages
            // without images). Shared-types MessageDTO.images? is optional.
            ...(images && { images }),
            timestamp: ts,
          });
        } catch {
          // skip malformed line
        }
      }

      return c.json({
        sessionId: id,
        messageCount: messages.length,
        messages,
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') {
        return c.json({
          sessionId: id,
          messageCount: 0,
          messages: [],
        });
      }
      return c.json({ error: `Failed to read messages: ${e.message}` }, 500);
    }
  });

  // POST /api/sessions/agents/:agentId — PLACEHOLDER + spawn worker.
  // Returns full context (4-class commands + globally available models) so the IDE
  // shows prompts/skills/extensions immediately, without waiting for the first prompt.
  // DB row is NOT written — that happens on first POST /:id/prompt (handled by spawnAndCreate).
  router.post('/agents/:agentId', async (c) => {
    const agentId = c.req.param('agentId');
    const agent = agentRepo.get(agentId);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);
    if (!existsSync(agent.workspacePath)) {
      return c.json({ error: `Agent workspacePath does not exist: ${agent.workspacePath}. Edit the agent to set a valid directory.` }, 400);
    }

    const sessionId = sessionRepo.newSessionId();
    try {
      await spawnPlaceholder(sessionId, agent, workerPool);
      const [commands, models] = await Promise.all([
        workerPool.call<SlashCommandDTO[]>(sessionId, 'listCommands', []),
        workerPool.call<ModelInfo[]>(sessionId, 'listAvailableModels', []),
      ]);
      const response: PlaceholderSessionResponse = { sessionId, agentId, commands, models };
      return c.json(response, 200);
    } catch (err) {
      // Cleanup partial worker on spawn failure (e.g. LRU-evict failed and capacity exceeded)
      if (workerPool.has(sessionId)) await workerPool.kill(sessionId, 'spawn-failed');
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No placeholder worker available to evict')) {
        return c.json({ error: 'Server at worker capacity. Please close some tabs.', code: 'capacity_exceeded' }, 503);
      }
      throw err;
    }
  });

  // POST /api/sessions/:id/prompt — ACTUAL creation + prompt (requires agentId)
  router.post('/:id/prompt', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as PromptRequest & { agentId: string; streamingBehavior?: 'steer' | 'followUp' };

    if (!body.agentId) return c.json({ error: 'Missing agentId in body (placeholder sessions require it)' }, 400);
    if (!body.message) return c.json({ error: 'Missing message in body' }, 400);
    if (body.streamingBehavior !== undefined && body.streamingBehavior !== 'steer' && body.streamingBehavior !== 'followUp') {
      return c.json({ error: 'Invalid streamingBehavior (must be steer or followUp)', code: 'invalid_streaming_behavior' }, 400);
    }

    const agent = agentRepo.get(body.agentId);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);

    // Validate workspacePath exists before spawning worker.
    // On Windows, CreateProcessW fails with ENOENT if the cwd doesn't exist.
    if (!existsSync(agent.workspacePath)) {
      return c.json(
        {
          error: `Agent workspacePath does not exist: ${agent.workspacePath}. Edit the agent to set a valid directory.`,
        },
        400,
      );
    }

    const existing = sessionRepo.get(id);

    // Case 1: Existing session row — respawn worker if missing (e.g. after restart).
    // Note: `status` is deprecated and ignored. Archived sessions are respawned on demand.
    if (existing) {
      if (existing.agentId !== body.agentId) {
        return c.json({ error: 'agentId mismatch with existing session' }, 400);
      }
      if (!workerPool.has(id)) {
        await spawnAndCreate(id, agent, sessionRepo, workerPool, existing.piSessionPath);
      }
      sessionRepo.update(id, {});
    } else {
      // Case 2: No session row — this is the placeholder sessionId being activated
      await spawnAndCreate(id, agent, sessionRepo, workerPool);
    }

    // Resolve attachment placeholders: extract `[pi-attachment:att_<id>]` markers
    // from message text, look them up in `attachments` table, forward to worker
    // via the second arg's `attachments` field. Read-tool images do NOT enter
    // here — they're owned by the source filesystem path the model read.
    // See proposal.md §'Concept boundary' for the user-attachment vs read-tool
    // distinction that this branch enforces.
    const messageText: string = typeof body.message === 'string' ? body.message : '';
    const referencedIds = Array.from(
      new Set(
        [...messageText.matchAll(/\[pi-attachment:(att_[a-z2-7]{13})\]/g)].map((m) => m[1] as string),
      ),
    );
    let attachmentMeta: Array<{ id: string; sha: string; mimeType: string }> | undefined;
    if (referencedIds.length > 0) {
      const found = attachmentStore.lookupForPrompt(id, referencedIds);
      const foundIds = new Set(found.map((r) => r.id));
      const missing = referencedIds.filter((rid) => !foundIds.has(rid));
      if (missing.length > 0) {
        return c.json(
          { error: 'Unknown attachment id', code: 'unknown_attachment', missingIds: missing },
          400,
        );
      }
      attachmentMeta = found.map((r) => ({ id: r.id, sha: r.sha, mimeType: r.mimeType }));
    }

    await workerPool.call(id, 'prompt', [
      body.message,
      {
        streamingBehavior: body.streamingBehavior,
        attachments: attachmentMeta,
      },
    ]);
    sessionRepo.update(id, {});

    const entry = workerPool.get(id);
    return c.json({ sessionId: id, workerPid: entry?.workerPid ?? -1 });
  });

  // POST /api/sessions/:id/abort
  router.post('/:id/abort', async (c) => {
    const id = c.req.param('id');
    if (!workerPool.has(id)) return c.json({ error: 'Session not active (worker not running)' }, 400);
    await workerPool.call(id, 'abort', []);
    return c.json({ ok: true });
  });

  // POST /api/sessions/:id/archive
  router.post('/:id/archive', async (c) => {
    const id = c.req.param('id');
    const session = sessionRepo.get(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    if (workerPool.has(id)) {
      await workerPool.kill(id, 'archive');
    }
    const archived = sessionRepo.archive(id);
    return c.json(archived);
  });

  // POST /api/sessions/:id/delete — HARD delete (DB row + pi session file on disk).
  // Use this for "user removed the session" — archive is the soft-delete path
  // (keeps row around, can be restored / reopened from history). Remove is for
  // cases where the user wants the session completely gone (e.g. cleanup).
  router.post('/:id/delete', async (c) => {
    const id = c.req.param('id');
    const session = sessionRepo.get(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    // Kill worker first so it doesn't keep writing to the file mid-unlink.
    if (workerPool.has(id)) {
      await workerPool.kill(id, 'deleted');
    }
    // Cascade attachments: DB-first order. Rows are facts; file rm is best-effort.
    // See `specs/session-deletion-cascade-attachments/spec.md` for the boundary rules.
    // Read-tool images do NOT enter this branch — they live in pi session file,
    // which is unlinked below in the same handler.
    const { rowsDeleted: attachmentsDeleted } = await attachmentStore.deleteBySession(id);
    // Remove pi session file. ENOENT is fine (already gone); other errors log + continue.
    try {
      await fs.unlink(session.piSessionPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        console.warn(
          `[server] session delete: failed to unlink ${session.piSessionPath}: ${(err as Error).message}`,
        );
      }
    }
    const removed = sessionRepo.delete(id);
    if (!removed) {
      // Row was already gone (race). Still report success — file + worker are cleaned.
      return c.json({ ok: true, id, alreadyGone: true, attachmentsDeleted });
    }
    return c.json({ ok: true, id, attachmentsDeleted });
  });

  // POST /api/sessions/:id/close — kill worker without archiving (chat tab closed in IDE)
  router.post('/:id/close', async (c) => {
    const id = c.req.param('id');
    if (!workerPool.has(id)) return c.json({ error: 'Session not active (worker not running)' }, 400);
    await workerPool.kill(id, 'tab-closed');
    // NOTE: session row stays in DB (not archived). User can reopen from history.
    return c.json({ ok: true });
  });

  // POST /api/sessions/:id/rename — update session title (D-A2)
  router.post('/:id/rename', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as { title?: string };
    const raw = body.title;
    // Title: 1-200 chars, null/empty → clear title (undefined to unset)
    let title: string | undefined;
    if (raw === undefined || raw === null || raw.trim() === '') {
      title = undefined;
    } else {
      const trimmed = raw.trim();
      if (trimmed.length > 200) {
        return c.json({ error: 'Title too long (max 200 chars)', code: 'title_too_long' }, 400);
      }
      title = trimmed;
    }
    const session = sessionRepo.get(id);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    sessionRepo.update(id, { title });
    return c.json({ ok: true, title });
  });

  // POST /api/sessions/:id/model — set current session's model (C4, D11)
  router.post('/:id/model', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as { provider?: string; modelId?: string };
    if (!body.provider || !body.modelId) {
      return c.json({ error: 'Missing provider or modelId', code: 'invalid_params' }, 400);
    }
    if (!workerPool.has(id)) return c.json({ error: 'Session not active (worker not running)' }, 400);
    await workerPool.call(id, 'setModel', [body.provider, body.modelId]);
    // Sync the entry so /:id/context can report the new currentModel without an extra IPC round-trip.
    workerPool.setModel(id, { provider: body.provider, modelId: body.modelId });
    // Persist as `provider/modelId` so `GET /:id` returns a parseable runtime model identifier.
    sessionRepo.update(id, { model: `${body.provider}/${body.modelId}` });
    return c.json({ ok: true, provider: body.provider, modelId: body.modelId });
  });

  // POST /api/sessions/:id/think — set current session's thinking level (C5, D13)
  // Session-only; NOT persisted to agents table.
  router.post('/:id/think', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as { level?: string };
    const VALID = ['off', 'low', 'medium', 'high'];
    if (!body.level || !VALID.includes(body.level)) {
      return c.json({ error: `Invalid level (must be one of ${VALID.join(', ')})`, code: 'invalid_level' }, 400);
    }
    if (!workerPool.has(id)) return c.json({ error: 'Session not active (worker not running)' }, 400);
    const level = body.level as 'off' | 'low' | 'medium' | 'high';
    await workerPool.call(id, 'setThinkingLevel', [level]);
    // Sync the entry so /:id/context can report the new currentThinkingLevel without an extra IPC round-trip.
    workerPool.setThinkingLevel(id, level);
    // NOTE: per OQ-D2 decision, do NOT persist to agents table or sessions.thinkingLevel.
    return c.json({ ok: true, level: body.level });
  });

  // POST /api/sessions/import-from-file — register an EXISTING pi session file
  // (e.g. produced by `pi` TUI) into the sessions table without spawning a worker.
  //
  // Flow:
  //   1. Caller (IDE "关联 pi 会话" button) selects an agent and a session file
  //      on disk. The session file was never tracked by this server.
  //   2. We read the first JSONL line — pi session files always start with a
  //      SessionHeader { type: "session", id, version, cwd, timestamp }.
  //   3. The header's `id` becomes the sessions.id PK. Other config fields
  //      (model, systemPrompt, appendSystemPrompt, tools, config) snapshot
  //      from the chosen agent — same code path as a normal session creation.
  //
  // Returns 201 with the created session DTO on success. 4xx for missing args /
  // agent / file / header.
  router.post('/import-from-file', async (c) => {
    const body = (await c.req.json()) as { agentId?: string; piSessionPath?: string; title?: string };
    if (!body.agentId || !body.piSessionPath) {
      return c.json({ error: 'Missing agentId or piSessionPath' }, 400);
    }
    const agent = agentRepo.get(body.agentId);
    if (!agent) return c.json({ error: 'Agent not found' }, 404);
    if (!existsSync(body.piSessionPath)) {
      return c.json({ error: `piSessionPath does not exist: ${body.piSessionPath}` }, 400);
    }

    let sessionId: string;
    try {
      const content = await fs.readFile(body.piSessionPath, 'utf8');
      const firstLine = content.split('\n').find((l) => l.trim());
      if (!firstLine) {
        return c.json({ error: 'Empty session file' }, 400);
      }
      const header = JSON.parse(firstLine) as { type?: string; id?: unknown };
      if (header.type !== 'session' || typeof header.id !== 'string' || header.id.length === 0) {
        return c.json(
          { error: 'File is not a valid pi session file (header.type !== "session" or id missing)' },
          400,
        );
      }
      sessionId = header.id;
    } catch (err) {
      return c.json({ error: `Failed to parse session file: ${(err as Error).message}` }, 400);
    }

    // If the row already exists (id collision), return the existing one instead of
    // 500'ing — re-linking the same file should be idempotent for the user.
    const existing = sessionRepo.get(sessionId);
    if (existing) {
      return c.json(existing, 200);
    }

    const created = sessionRepo.createFromAgent({
      sessionId,
      agentId: body.agentId,
      piSessionPath: body.piSessionPath,
      title: body.title,
    });
    if (!created) {
      return c.json({ error: 'Failed to create session row' }, 500);
    }
    return c.json(created, 201);
  });

  // GET /api/sessions/:id/commands — REMOVED in session-lifecycle-v2.
// Use GET /api/sessions/:id/context instead (commands are part of context).

  // POST /api/sessions/:id/command — dispatch slash command (C3, D4)
  //
  // Builtin commands (session / name / hotkeys / model / thinking / compact) are
  // handled SERVER-side: `session` / `hotkeys` / `name` don't need a worker, so
  // they work on placeholder sessions too (chat tab just opened, no message sent
  // yet). `model` / `thinking` / `compact` need a live worker (they call into it).
  // Non-builtin commands (extensions / prompt templates / skills) are forwarded
  // to the worker's dispatchCommand.
  router.post('/:id/command', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as { name?: string; args?: string };
    if (!body.name) {
      return c.json({ error: 'Missing name', code: 'invalid_params' }, 400);
    }
    const name = body.name;
    const args = (body.args ?? '').trim();

    if (BUILTIN_SERVER_COMMANDS.includes(name)) {
      const needsWorker = name === 'model' || name === 'thinking' || name === 'compact';
      if (needsWorker && !workerPool.has(id)) {
        return c.json({ error: 'Session not active (send a message first)', code: 'session_not_active' }, 400);
      }
      switch (name) {
        case 'session': {
          const session = sessionRepo.get(id);
          if (!session) {
            return c.json({ ok: true, result: { kind: 'text', content: 'This session is a placeholder — send a message to activate it.' } });
          }
          const content = [
            `**Session** \`${session.id.slice(0, 8)}\``,
            `- Status: ${session.status}`,
            `- Title: ${session.title ?? '(untitled)'}`,
            `- Model: ${session.model}`,
            `- Thinking: ${session.thinkingLevel ?? '(default)'}`,
            `- Worker: ${workerPool.has(id) ? 'running' : 'not running'}`,
            `- Created: ${new Date(session.createdAt).toLocaleString()}`,
          ].join('\n');
          return c.json({ ok: true, result: { kind: 'text', content } });
        }
        case 'name': {
          const session = sessionRepo.get(id);
          if (!session) return c.json({ error: 'Session not found', code: 'session_not_found' }, 404);
          if (!args) {
            return c.json({ ok: true, result: { kind: 'text', content: `Current title: ${session.title ?? '(untitled)'}\n\nUsage: /name <title>` } });
          }
          if (args.length > 200) {
            return c.json({ error: 'Title too long (max 200 chars)', code: 'title_too_long' }, 400);
          }
          sessionRepo.update(id, { title: args });
          return c.json({ ok: true, result: { kind: 'text', content: `Session renamed to \`${args}\`` } });
        }
        case 'hotkeys': {
          const content = [
            '**Keyboard shortcuts**',
            '- `Enter` — send message',
            '- `Shift+Enter` — newline',
            '- `/` — open slash command menu',
            '- `@` — reference a file',
            '- `Esc` — close menu',
          ].join('\n');
          return c.json({ ok: true, result: { kind: 'text', content } });
        }
        case 'model': {
          const slashIdx = args.indexOf('/');
          if (slashIdx <= 0 || !args.slice(slashIdx + 1)) {
            return c.json({ ok: true, result: { kind: 'text', content: 'Usage: /model <provider>/<modelId>' } });
          }
          const provider = args.slice(0, slashIdx);
          const modelId = args.slice(slashIdx + 1);
          await workerPool.call(id, 'setModel', [provider, modelId]);
          sessionRepo.update(id, { model: args });
          return c.json({ ok: true, result: { kind: 'text', content: `Model set to \`${args}\`` } });
        }
        case 'thinking': {
          const VALID = ['off', 'low', 'medium', 'high'];
          if (!VALID.includes(args)) {
            return c.json({ ok: true, result: { kind: 'text', content: 'Usage: /thinking <off|low|medium|high>' } });
          }
          await workerPool.call(id, 'setThinkingLevel', [args]);
          return c.json({ ok: true, result: { kind: 'text', content: `Thinking level set to \`${args}\`` } });
        }
        case 'compact': {
          await workerPool.call(id, 'compact', []);
          return c.json({ ok: true, result: { kind: 'text', content: 'Session context compacted.' } });
        }
      }
    }

    // Non-builtin (extension / prompt / skill): needs a live worker
    if (!workerPool.has(id)) {
      return c.json({ error: 'Session not active (send a message first)', code: 'session_not_active' }, 400);
    }
    try {
      await workerPool.call(id, 'dispatchCommand', [body.name, body.args ?? '']);
      return c.json({ ok: true, result: null });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith('Unknown command:')) {
        return c.json({ error: msg, code: 'unknown_command' }, 400);
      }
      throw err;
    }
  });

  return router;
}

/**
 * Slash commands exposed to the IDE before a session is promoted to a real row.
 * Mirrors `IDE_EXPOSED_BUILTINS` in the worker (see platform/workers/session-worker/src/session.ts).
 */
const PLACEHOLDER_BUILTIN_COMMANDS = [
  { name: 'model', description: 'Select model', argumentHint: '<provider/model>', source: 'builtin' },
  { name: 'thinking', description: 'Set thinking level', argumentHint: '<level>', source: 'builtin' },
  { name: 'name', description: 'Set session display name', argumentHint: '<name>', source: 'builtin' },
  { name: 'session', description: 'Show session info and stats', source: 'builtin' },
  { name: 'compact', description: 'Manually compact the session context', source: 'builtin' },
  { name: 'hotkeys', description: 'Show all keyboard shortcuts', source: 'builtin' },
]

/** Compute the current model for /:id/context.
 *  Priority:
 *    1. worker entry's cached model (works for placeholder AND active — entry.model is set
 *       by spawnPlaceholder / spawnAndCreate / POST /:id/model)
 *    2. parse session.model (`provider/modelId` format) when there's a DB row
 *    3. null when neither is available */
function computeCurrentModel(
  session: { model: string } | null,
  entryModel: { provider: string; modelId: string } | null | undefined,
): { provider: string; modelId: string } | null {
  if (entryModel) return entryModel;
  if (session?.model) {
    const slashIdx = session.model.indexOf('/');
    if (slashIdx > 0) {
      return { provider: session.model.slice(0, slashIdx), modelId: session.model.slice(slashIdx + 1) };
    }
    return { provider: '', modelId: session.model };
  }
  return null;
}

/** Compute the active thinking level for /:id/context.
 *  Priority: worker entry cache → session.thinkingLevel → null. */
function computeCurrentThinkingLevel(
  session: { thinkingLevel?: string | null } | null,
  entryLevel: 'off' | 'low' | 'medium' | 'high' | null | undefined,
): 'off' | 'low' | 'medium' | 'high' | null {
  if (entryLevel) return entryLevel;
  if (session?.thinkingLevel) return session.thinkingLevel as 'off' | 'low' | 'medium' | 'high';
  return null;
}

/**
 * Fetch the worker's system prompt over IPC and cache it on the WorkerEntry so
 * /:id/context can return the full systemPrompt text without re-fetching 10K+ chars
 * on every context call. Non-fatal: if it fails, /:id/context just omits the field.
 */
async function cacheSystemPrompt(
  sessionId: string,
  workerPool: WorkerPool,
): Promise<void> {
  try {
    const sp = await workerPool.call<{ text: string; length: number; source: 'override' | 'default' }>(
      sessionId,
      'getSystemPrompt',
      [],
    );
    if (sp) workerPool.setSystemPrompt(sessionId, sp);
  } catch (err) {
    console.warn(`[sessions] cacheSystemPrompt failed for ${sessionId}:`, err);
  }
}

/**
 * Builtin slash commands handled server-side by POST /:id/command.
 * Keep in sync with PLACEHOLDER_BUILTIN_COMMANDS above.
 */
const BUILTIN_SERVER_COMMANDS = ['model', 'thinking', 'name', 'session', 'compact', 'hotkeys']

async function spawnPlaceholder(
  sessionId: string,
  agent: { id: string; workspacePath: string; model: string; thinkingLevel?: string; config?: AgentConfig },
  workerPool: WorkerPool,
) {
  await workerPool.spawn(sessionId, agent.workspacePath);
  const runtimeConfig: RuntimeConfig = {
    workspacePath: agent.workspacePath,
    model: agent.model,
    thinkingLevel: agent.thinkingLevel,
    config: agent.config,
  };
  // existingSessionPath is always undefined for placeholders — no row exists yet.
  const result = await workerPool.call<{
    piSessionPath: string;
    model?: { provider: string; modelId: string } | null;
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | null;
  }>(sessionId, 'createSession', [runtimeConfig, sessionId, undefined]);
  // Cache piSessionPath on the entry so a subsequent spawnAndCreate on this still-alive
  // placeholder worker can persist the row without re-creating the session.
  workerPool.setSessionPath(sessionId, result.piSessionPath);
  // Cache the actual model the worker will use (drives /:id/context's currentModel
  // for placeholder sessions that don't yet have a DB row).
  workerPool.setModel(sessionId, result.model ?? null);
  // Same for thinkingLevel — placeholder sessions also need this immediately.
  workerPool.setThinkingLevel(sessionId, result.thinkingLevel ?? null);
  // Cache the system prompt for /:id/context (avoid re-fetching 10K+ chars per call).
  await cacheSystemPrompt(sessionId, workerPool);
  // NOTE: deliberately NOT calling markRowWritten. The worker stays `hasRow=false`
  // so it participates in placeholder timeout + LRU eviction.
}

async function spawnAndCreate(
  sessionId: string,
  agent: { id: string; workspacePath: string; model: string; thinkingLevel?: string; config?: AgentConfig },
  sessionRepo: SessionRepo,
  workerPool: WorkerPool,
  existingSessionPath?: string,
) {
  // If a worker is already alive (placeholder scenario from POST /agents/:agentId),
  // reuse it instead of spawning again — workerPool.spawn() throws 'worker already exists'.
  let piSessionPath: string;
  let actualModelOverride: string | undefined;
  let actualThinkingLevelOverride: 'off' | 'low' | 'medium' | 'high' | undefined;
  if (workerPool.has(sessionId)) {
    const entry = workerPool.get(sessionId);
    if (!entry?.piSessionPath) {
      // Defensive: shouldn't happen if spawnPlaceholder always sets the path.
      throw new Error(`placeholder worker ${sessionId} has no cached piSessionPath`);
    }
    piSessionPath = entry.piSessionPath;
    // Reuse cached model from entry — worker was already initialized by spawnPlaceholder.
    actualModelOverride = entry.model ? `${entry.model.provider}/${entry.model.modelId}` : undefined;
    // Reuse cached thinkingLevel too — same reason.
    actualThinkingLevelOverride = entry.thinkingLevel ?? undefined;
  } else {
    await workerPool.spawn(sessionId, agent.workspacePath);
    const runtimeConfig: RuntimeConfig = {
      workspacePath: agent.workspacePath,
      model: agent.model,
      thinkingLevel: agent.thinkingLevel,
      config: agent.config,
    };
    const result = (await workerPool.call<{
      sessionHandle: string;
      piSessionPath: string;
      model?: { provider: string; modelId: string } | null;
      thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | null;
    }>(sessionId, 'createSession', [runtimeConfig, sessionId, existingSessionPath]));
    piSessionPath = result.piSessionPath;
    actualModelOverride = result.model ? `${result.model.provider}/${result.model.modelId}` : undefined;
    actualThinkingLevelOverride = result.thinkingLevel ?? undefined;
    workerPool.setSessionPath(sessionId, piSessionPath);
    workerPool.setModel(sessionId, result.model ?? null);
    workerPool.setThinkingLevel(sessionId, result.thinkingLevel ?? null);
    // Cache the system prompt for /:id/context (avoid re-fetching 10K+ chars per call).
    await cacheSystemPrompt(sessionId, workerPool);
  }

  // Persist the model the worker will actually use. When the worker was just spawned
  // (actualModelOverride set above), use it; otherwise (worker reused) fall back to agent.model.
  const actualModel = actualModelOverride ?? agent.model;

  // Update existing placeholder row (or create new) with worker output.
  const existing = sessionRepo.get(sessionId);
  const created = existing
    ? sessionRepo.update(sessionId, { model: actualModel }) ?? sessionRepo.get(sessionId)
    : sessionRepo.createFromAgent({
        sessionId,
        agentId: agent.id,
        piSessionPath: piSessionPath,
        modelOverride: actualModel,
      });

  if (!created) {
    await workerPool.kill(sessionId, 'create-failed');
    return undefined;
  }
  // Mark the worker as active so it's excluded from placeholder timeout + LRU eviction.
  workerPool.markRowWritten(sessionId);
  return created;
}