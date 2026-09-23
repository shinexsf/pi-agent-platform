/**
 * session-bridge — shared spawn helpers used by both routes/sessions.ts (web/IDE)
 * and im-gateway/routing.ts (IM channels).
 *
 * Extracted from routes/sessions.ts so IM gateway can re-use the exact same
 * session lifecycle (placeholder → first prompt → active) without going through
 * HTTP.
 *
 * Pipeline (mirrors routes/sessions.ts:spawnPlaceholder / spawnAndCreate):
 *   1. spawnPlaceholder(sessionId, agent, workerPool)
 *      - workerPool.spawn(sessionId, workspacePath)
 *      - workerPool.call(sessionId, 'createSession', [runtimeConfig, sessionId, undefined])
 *      - caches piSessionPath on the entry (no DB row yet)
 *   2. spawnAndCreate(sessionId, agent, sessionRepo, workerPool, existingSessionPath?)
 *      - if worker already alive (placeholder): reuse + just persist the row
 *      - else spawn fresh worker + createSession + persist row
 *      - markRowWritten so it's excluded from placeholder timeout / LRU
 */

import type { RuntimeConfig, AgentConfig } from '@pi-agent-platform/shared-types';
import type { WorkerPool } from '../worker-pool.js';
import type { AgentRepo } from '../repos/agent.repo.js';
import type { SessionRepo } from '../repos/session.repo.js';
import { readSettings, type GlobalSettings } from '../services/settings-reader.js';
import { logger } from './logger.js';

interface AgentLike {
  id: string;
  workspacePath: string;
  model: string;
  thinkingLevel?: string;
  config?: AgentConfig;
}

interface CreateSessionResult {
  sessionHandle?: string;
  piSessionPath: string;
  model?: { provider: string; modelId: string } | null;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | null;
  /** pi-native session display name (session-title-sync heal input). */
  sessionName?: string;
}

/** Phase 1: spawn placeholder worker + createSession (no DB row yet). */
export async function spawnPlaceholder(
  sessionId: string,
  agent: AgentLike,
  workerPool: WorkerPool,
): Promise<void> {
  await workerPool.spawn(sessionId, agent.workspacePath);
  const runtimeConfig = buildRuntimeConfig(agent);
  const result = await workerPool.call<CreateSessionResult>(
    sessionId,
    'createSession',
    [runtimeConfig, sessionId, undefined],
  );
  workerPool.setSessionPath(sessionId, result.piSessionPath);
  workerPool.setModel(sessionId, result.model ?? null);
  workerPool.setThinkingLevel(sessionId, result.thinkingLevel ?? null);
  workerPool.setSessionName(sessionId, result.sessionName);
  // Cache the system prompt for /:id/context (avoid IPC round-trip on every
  // context fetch; the prompt can be 10K+ chars).
  await cacheSystemPrompt(sessionId, workerPool);
}

/**
 * Phase 2: persist session row + ensure worker is alive.
 *
 * - If worker alive (placeholder): reuse, just persist row + update model.
 * - If worker dead: spawn fresh, pass `existingSessionPath` so pi re-loads history.
 */
export async function spawnAndCreate(
  sessionId: string,
  agent: AgentLike,
  sessionRepo: SessionRepo,
  workerPool: WorkerPool,
  existingSessionPath?: string,
): Promise<{ piSessionPath: string } | undefined> {
  let piSessionPath: string;
  let piSessionName: string | undefined;
  let actualModelOverride: string | undefined;
  let actualThinkingLevelOverride: 'off' | 'low' | 'medium' | 'high' | undefined;

  if (workerPool.has(sessionId)) {
    const entry = workerPool.get(sessionId);
    if (!entry?.piSessionPath) {
      throw new Error(`placeholder worker ${sessionId} has no cached piSessionPath`);
    }
    piSessionPath = entry.piSessionPath;
    piSessionName = entry.sessionName;
    actualModelOverride = entry.model ? `${entry.model.provider}/${entry.model.modelId}` : undefined;
    actualThinkingLevelOverride = entry.thinkingLevel ?? undefined;
  } else {
    await workerPool.spawn(sessionId, agent.workspacePath);
    const runtimeConfig = buildRuntimeConfig(agent);
    const result = await workerPool.call<CreateSessionResult>(
      sessionId,
      'createSession',
      [runtimeConfig, sessionId, existingSessionPath],
    );
    piSessionPath = result.piSessionPath;
    piSessionName = result.sessionName;
    actualModelOverride = result.model ? `${result.model.provider}/${result.model.modelId}` : undefined;
    actualThinkingLevelOverride = result.thinkingLevel ?? undefined;
    workerPool.setSessionPath(sessionId, piSessionPath);
    workerPool.setModel(sessionId, result.model ?? null);
    workerPool.setThinkingLevel(sessionId, result.thinkingLevel ?? null);
    workerPool.setSessionName(sessionId, result.sessionName);
    await cacheSystemPrompt(sessionId, workerPool);
  }

  const actualModel = actualModelOverride ?? agent.model;
  const existing = sessionRepo.get(sessionId);
  const created = existing
    ? sessionRepo.update(sessionId, { model: actualModel }) ?? sessionRepo.get(sessionId)
    : sessionRepo.createFromAgent({
        sessionId,
        agentId: agent.id,
        piSessionPath,
        modelOverride: actualModel,
      });

  if (!created) {
    await workerPool.kill(sessionId, 'create-failed');
    return undefined;
  }
  workerPool.markRowWritten(sessionId);

  // ── Heal (session-title-sync, design D5): converge pi-native name to DB title ──
  // Equal (incl. both empty) → skip: no extra jsonl entry on every respawn.
  // Diverged → DB wins via setSessionName; covers worker-dead renames (direct DB
  // write) and legacy drift. Runs before the caller dispatches the prompt.
  await healPiSessionName(sessionId, workerPool, created.title, piSessionName);

  return { piSessionPath };
}

/**
 * Heal the pi-native session name toward the DB title (DB wins — design D5).
 * - db === pi (incl. both empty) → no-op (idempotent; avoids jsonl entry spam).
 * - both set but different → info-log the conflict, then overwrite pi with DB.
 * Placeholder sessions never reach this: heal only runs inside spawnAndCreate,
 * which always has a row by the time it executes.
 */
async function healPiSessionName(
  sessionId: string,
  workerPool: WorkerPool,
  dbTitle: string | undefined,
  piName: string | undefined,
): Promise<void> {
  const db = (dbTitle ?? '').trim();
  const pi = (piName ?? '').trim();
  if (db === pi) return;
  if (db && pi) {
    logger.info({ sessionId, dbTitle: db, piName: pi }, 'session title conflict: DB wins (heal)');
  }
  try {
    await workerPool.call(sessionId, 'setSessionName', [db]);
    logger.debug({ sessionId, title: db || null }, 'healed pi session name from DB title');
  } catch (err) {
    logger.warn({ err, sessionId }, 'heal setSessionName failed');
  }
}

function buildRuntimeConfig(agent: AgentLike): RuntimeConfig {
  // Merge agent config with global defaults from settings.json
  const mergedConfig = mergeWithGlobalDefaults(agent.config);
  return {
    workspacePath: agent.workspacePath,
    model: agent.model,
    thinkingLevel: agent.thinkingLevel,
    config: mergedConfig,
  };
}

/**
 * Merge agent config with global defaults from settings.json.
 * When agent config field is null/undefined, use the global default.
 * When agent config field is set (including empty array), use it as-is.
 */
function mergeWithGlobalDefaults(agentConfig?: AgentConfig): AgentConfig | undefined {
  const globalSettings = readSettings();
  
  // No global defaults configured — return agent config as-is
  if (!globalSettings) return agentConfig;
  
  // No agent config — create one with just global defaults
  if (!agentConfig) {
    return {
      builtinTools: globalSettings.defaultBuiltinTools,
      extensions: globalSettings.defaultExtensions,
      skills: globalSettings.defaultSkills,
      prompts: globalSettings.defaultPrompts,
    };
  }
  
  // Merge: agent config fields take precedence, fall back to global defaults
  return {
    ...agentConfig,
    builtinTools: agentConfig.builtinTools ?? globalSettings.defaultBuiltinTools,
    extensions: agentConfig.extensions ?? globalSettings.defaultExtensions,
    skills: agentConfig.skills ?? globalSettings.defaultSkills,
    prompts: agentConfig.prompts ?? globalSettings.defaultPrompts,
  };
}

/**
 * Fetch the worker's system prompt over IPC and cache it on the WorkerEntry.
 * Used after createSession so /:id/context can return the full prompt text
 * without re-fetching ~10K+ chars on every context call.
 */
async function cacheSystemPrompt(sessionId: string, workerPool: WorkerPool): Promise<void> {
  try {
    const sp = await workerPool.call<{ text: string; length: number; source: 'override' | 'default' }>(
      sessionId,
      'getSystemPrompt',
      [],
    );
    if (sp) workerPool.setSystemPrompt(sessionId, sp);
  } catch (err) {
    // Non-fatal: /:id/context will just omit systemPrompt for this session.
    logger.warn({ err, sessionId }, 'cacheSystemPrompt failed');
  }
}

export type { AgentLike };