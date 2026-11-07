/**
 * trigger.* capabilities (change: trigger-scheduling).
 *
 * All of them are `scoped: true`: write access is own-mode, so an agent may
 * only touch triggers belonging to its own agent (authorize.ts resolves the
 * owner via `resolveTriggerAgent` / `params.agentId`).
 *
 * `sendNotifyToUser` is deliberately NOT a capability — it is a server tool
 * (reverse call), because it is not a management operation.
 */

import type { AnyCapabilityDef, TriggerDTO } from '@pi-agent-platform/shared-types';
import type { TriggerRuntime } from '../../services/trigger/runtime.js';
import { getTriggerSource, listTriggerSources } from '../../services/trigger/sources.js';
import { generateWebhookSecret } from '../../services/trigger/sources/webhook.js';
import { resolveSessionBinding } from '../../services/trigger/session-binding.js';
import type { InvokeContext } from '@pi-agent-platform/shared-types';

const MAX_TRIGGERS_PER_AGENT = 10;

function notFound(id: string): Error {
  const e = new Error(`Trigger not found: ${id}`);
  e.name = 'NotFoundError';
  return e;
}

function redact(trigger: TriggerDTO): TriggerDTO {
  const secret = trigger.config?.secret;
  if (typeof secret !== 'string') return trigger;
  return { ...trigger, config: { ...trigger.config, secret: undefined, secretEnding: secret.slice(-4) } };
}

export function triggerCapabilities(rt: TriggerRuntime): AnyCapabilityDef[] {
  const { repo, dispatcher, scheduler } = rt;

  const list: AnyCapabilityDef = {
    method: 'trigger.list',
    module: 'trigger',
    access: 'read',
    scoped: false,
    summary: '列出触发器（可按 agentId / source 过滤；默认只含启用中的）',
    paramsSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        source: { type: 'string' },
        includeDisabled: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    returns: 'TriggerDTO 数组（secret 已脱敏）+ 已注册 source 列表',
    handler: (_ctx: InvokeContext, params) => {
      const p = (params ?? {}) as { agentId?: string; source?: string; includeDisabled?: boolean };
      return {
        triggers: repo
          .list({ agentId: p.agentId, source: p.source, includeDisabled: p.includeDisabled === true })
          .map(redact),
        sources: listTriggerSources().map((s) => s.source),
      };
    },
  };

  const get: AnyCapabilityDef = {
    method: 'trigger.get',
    module: 'trigger',
    access: 'read',
    scoped: false,
    summary: '取单个触发器详情（含最近 20 次运行）',
    paramsSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    returns: '{ trigger, runs }',
    handler: (_ctx, params) => {
      const id = (params as { id?: string })?.id;
      if (!id) throw new Error('trigger.get: id is required');
      const trigger = repo.get(id);
      if (!trigger) throw notFound(id);
      return { trigger: redact(trigger), runs: repo.listRuns(id, 20) };
    },
  };

  const create: AnyCapabilityDef = {
    method: 'trigger.create',
    module: 'trigger',
    access: 'write',
    scoped: true,
    summary: '创建触发器（只能为调用者自己的 agent 创建；每 agent 最多 10 个启用的）',
    paramsSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '省略则用调用者自己的 agent' },
        name: { type: 'string' },
        source: { type: 'string' },
        config: { type: 'object' },
        prompt: { type: 'string' },
        sessionMode: { type: 'string', enum: ['new', 'reuse'] },
        sessionId: {
          type: 'string',
          description: 'reuse 模式下要固定的已有会话 id（必须是本 agent 的会话）；省略 = 首次触发时自动创建',
        },
        maxRuns: { type: 'number' },
      },
      required: ['name', 'source', 'prompt'],
      additionalProperties: false,
    },
    returns: 'TriggerDTO（webhook source 额外返回一次明文 secret）',
    handler: (ctx, params) => {
      const p = (params ?? {}) as {
        agentId?: string;
        name?: string;
        source?: string;
        config?: Record<string, unknown>;
        prompt?: string;
        sessionMode?: 'new' | 'reuse';
        sessionId?: string | null;
        maxRuns?: number;
      };
      const agentId = p.agentId ?? ctx.agentId;
      if (!agentId) throw new Error('trigger.create: cannot resolve target agent');
      const spec = getTriggerSource(String(p.source ?? ''));
      if (!spec) {
        throw new Error(`trigger.create: unknown source ${p.source} (available: ${listTriggerSources().map((s) => s.source).join(', ')})`);
      }
      if (repo.countEnabledForAgent(agentId) >= MAX_TRIGGERS_PER_AGENT) {
        throw new Error(`trigger.create: 每 agent 最多 ${MAX_TRIGGERS_PER_AGENT} 个启用的触发器`);
      }
      const rawConfig: Record<string, unknown> = { ...(p.config ?? {}) };
      if (spec.hasSecret && (typeof rawConfig.secret !== 'string' || rawConfig.secret.length < 16)) {
        rawConfig.secret = generateWebhookSecret();
      }
      const config = spec.validateConfig(rawConfig);
      const sessionMode = p.sessionMode === 'reuse' ? 'reuse' : 'new';
      const sessionId = resolveSessionBinding(rt.sessionRepo, { agentId, sessionMode, sessionId: p.sessionId });
      const created = repo.create({
        agentId,
        name: String(p.name ?? 'trigger'),
        source: spec.source,
        config,
        prompt: String(p.prompt ?? ''),
        sessionMode,
        enabled: true,
        nextAt: spec.computeNextAt?.(config, Date.now()) ?? null,
        maxRuns: p.maxRuns && p.maxRuns > 0 ? p.maxRuns : (spec.defaultMaxRuns ?? null),
        sessionId,
      });
      scheduler.reschedule();
      return spec.hasSecret ? { ...redact(created), secret: config.secret } : redact(created);
    },
  };

  const update: AnyCapabilityDef = {
    method: 'trigger.update',
    module: 'trigger',
    access: 'write',
    scoped: true,
    summary: '更新触发器（name / config / prompt / sessionMode / sessionId / enabled / maxRuns）',
    paramsSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        config: { type: 'object' },
        prompt: { type: 'string' },
        sessionMode: { type: 'string', enum: ['new', 'reuse'] },
        sessionId: {
          type: 'string',
          description: 'reuse 目标会话：传值 = 换绑（必须是本 agent 的会话）；传空串 = 解绑回"首次触发时创建"',
        },
        enabled: { type: 'boolean' },
        maxRuns: { type: 'number' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    returns: 'TriggerDTO',
    handler: (_ctx, params) => {
      const p = (params ?? {}) as {
        id?: string;
        name?: string;
        config?: Record<string, unknown>;
        prompt?: string;
        sessionMode?: 'new' | 'reuse';
        sessionId?: string | null;
        enabled?: boolean;
        maxRuns?: number;
      };
      if (!p.id) throw new Error('trigger.update: id is required');
      const existing = repo.get(p.id);
      if (!existing) throw notFound(p.id);
      const spec = getTriggerSource(existing.source);
      let config = existing.config;
      let nextAt: number | null | undefined;
      if (p.config !== undefined) {
        config = spec ? spec.validateConfig({ ...p.config, secret: existing.config.secret }) : p.config;
        nextAt = spec?.computeNextAt?.(config, Date.now()) ?? null;
      }
      // Re-enabling recomputes the slot (see routes/triggers.ts for the reason).
      const reEnabling = p.enabled === true && !existing.enabled;
      if (reEnabling && nextAt === undefined) {
        nextAt = spec?.computeNextAt?.(config, Date.now()) ?? null;
      }
      // Session binding — same rule as routes/triggers.ts (one shared validator):
      // switching to `new` always clears it; on `reuse` re-validate whatever the
      // resulting binding is so an agent cannot aim at another agent's session.
      let sessionId: string | null | undefined;
      if (p.sessionId !== undefined || p.sessionMode !== undefined) {
        const sessionMode = p.sessionMode ?? existing.sessionMode;
        sessionId =
          sessionMode === 'reuse'
            ? resolveSessionBinding(rt.sessionRepo, {
                agentId: existing.agentId,
                sessionMode,
                sessionId: p.sessionId === undefined ? existing.sessionId : p.sessionId,
              })
            : null;
      }
      const effectiveMaxRuns = p.maxRuns === undefined ? existing.maxRuns : p.maxRuns;
      if (p.enabled === true && effectiveMaxRuns !== null && existing.runsCount >= effectiveMaxRuns) {
        throw new Error(`已达最大运行次数（${existing.runsCount}/${effectiveMaxRuns}），请先提高 maxRuns`);
      }
      const updated = repo.update(p.id, {
        name: p.name,
        config,
        prompt: p.prompt,
        sessionMode: p.sessionMode,
        ...(sessionId !== undefined ? { sessionId } : {}),
        enabled: p.enabled,
        maxRuns: p.maxRuns,
        ...(nextAt !== undefined ? { nextAt } : {}),
      });
      scheduler.reschedule();
      return updated ? redact(updated) : { error: 'not found' };
    },
  };

  const remove: AnyCapabilityDef = {
    method: 'trigger.delete',
    module: 'trigger',
    access: 'write',
    scoped: true,
    summary: '删除触发器（历史 runs 保留）',
    paramsSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    returns: '{ ok: true }',
    handler: (_ctx, params) => {
      const id = (params as { id?: string })?.id;
      if (!id) throw new Error('trigger.delete: id is required');
      if (!repo.delete(id)) throw notFound(id);
      scheduler.reschedule();
      return { ok: true };
    },
  };

  const run: AnyCapabilityDef = {
    method: 'trigger.run',
    module: 'trigger',
    access: 'write',
    scoped: true,
    summary: '立即触发一次（不影响 next_at；可带 payload）',
    paramsSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        payload: { description: '任意 JSON，进入信封 <data>' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    returns: '{ status, runId?, sessionId?, error? }',
    handler: async (_ctx, params) => {
      const p = (params ?? {}) as { id?: string; payload?: unknown };
      if (!p.id) throw new Error('trigger.run: id is required');
      const trigger = repo.get(p.id);
      if (!trigger) throw notFound(p.id);
      const event = dispatcher.eventFromTrigger(trigger, { triggeredBy: 'capability', payload: p.payload });
      return dispatcher.dispatch(event);
    },
  };

  return [list, get, create, update, remove, run];
}
