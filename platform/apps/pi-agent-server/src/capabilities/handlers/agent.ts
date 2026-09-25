/**
 * agent.* capabilities — list (fuzzy combo search) / get / update.
 * update is scoped: own-mode restricts to the caller's own agent row.
 */

import { existsSync } from 'node:fs';
import type { AgentDTO, AnyCapabilityDef, CapabilityDef } from '@pi-agent-platform/shared-types';
import type { AgentRepo } from '../../repos/agent.repo.js';
import { normalizePath } from '../../utils/normalize-path.js';

function notFound(id: string): Error {
  const e = new Error(`Agent not found: ${id}`);
  e.name = 'NotFoundError';
  return e;
}

/** Field subset returned by agent.list — full config can be huge; get returns the rest. */
function summary(a: AgentDTO): Pick<AgentDTO, 'id' | 'name' | 'description' | 'workspacePath' | 'model' | 'thinkingLevel'> {
  const { id, name, description, workspacePath, model, thinkingLevel } = a;
  return { id, name, description, workspacePath, model, thinkingLevel };
}

export function agentCapabilities(agentRepo: AgentRepo): AnyCapabilityDef[] {
  const list: CapabilityDef<{ name?: string; workspacePath?: string; description?: string }, unknown> = {
    method: 'agent.list',
    module: 'agent',
    access: 'read',
    scoped: false,
    summary: '搜索 agents：name / workspacePath / description 组合模糊过滤（子串匹配，AND 关系，不传=全部）',
    paramsSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'name 子串（不区分大小写）' },
        workspacePath: { type: 'string', description: 'workspacePath 前缀（含子目录）' },
        description: { type: 'string', description: 'description 子串（不区分大小写）' },
      },
      additionalProperties: false,
    },
    returns: '精简 agent 数组 [{ id, name, description, workspacePath, model, thinkingLevel }]',
    handler: (ctx, params) => {
      void ctx;
      let rows = agentRepo.list();
      if (params?.workspacePath) {
        const target = normalizePath(params.workspacePath);
        rows = rows.filter((a) => {
          const wp = normalizePath(a.workspacePath);
          return wp === target || wp.startsWith(`${target}/`);
        });
      }
      if (params?.name) {
        const q = params.name.toLowerCase();
        rows = rows.filter((a) => a.name.toLowerCase().includes(q));
      }
      if (params?.description) {
        const q = params.description.toLowerCase();
        rows = rows.filter((a) => (a.description ?? '').toLowerCase().includes(q));
      }
      return { agents: rows.map(summary), total: rows.length };
    },
  };

  const get: CapabilityDef<{ id: string }, unknown> = {
    method: 'agent.get',
    module: 'agent',
    access: 'read',
    scoped: true, // own-mode: id must be the caller's own agent
    summary: '按 id 取 agent 完整配置（含 config）',
    paramsSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'agent id' } },
      required: ['id'],
      additionalProperties: false,
    },
    returns: '完整 AgentDTO（含 config）；不存在 → 错误 "Agent not found: <id>"',
    handler: (ctx, params) => {
      void ctx;
      const a = agentRepo.get(params.id);
      if (!a) throw notFound(params.id);
      return a;
    },
  };

  const update: CapabilityDef<{ id: string; patch: Partial<AgentDTO> }, unknown> = {
    method: 'agent.update',
    module: 'agent',
    access: 'write',
    scoped: true, // own-mode: may only update the caller's own agent
    summary:
      '局部更新 agent 配置（name/description/workspacePath/model/thinkingLevel/config）。仅影响该 agent 未来新建的 session——运行中的 session 是创建时快照，不受影响',
    paramsSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'agent id' },
        patch: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            workspacePath: { type: 'string', description: '必须是已存在的绝对路径' },
            model: { type: 'string', description: 'provider/modelId' },
            thinkingLevel: { type: 'string', enum: ['off', 'low', 'medium', 'high'] },
            config: { type: 'object', description: 'AgentConfig 整体替换（systemPrompt/builtinTools/serverBuiltinTools/capabilities 等）' },
          },
          additionalProperties: false,
        },
      },
      required: ['id', 'patch'],
      additionalProperties: false,
    },
    returns: '更新后的完整 AgentDTO。生效时机：⚠️ 只影响未来创建的 session（完全快照语义），当前运行中的 session 不变',
    handler: (ctx, params) => {
      void ctx;
      const existing = agentRepo.get(params.id);
      if (!existing) throw notFound(params.id);
      if (params.patch.workspacePath !== undefined && !existsSync(normalizePath(params.patch.workspacePath))) {
        throw new Error(`workspacePath does not exist: ${params.patch.workspacePath}`);
      }
      const updated = agentRepo.update(params.id, params.patch);
      if (!updated) throw notFound(params.id);
      return updated;
    },
  };

  return [list, get, update];
}
