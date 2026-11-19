/**
 * inline 插件（change: plugin-mechanism-v2 / D16）。
 *
 * 定义：**编译进平台的插件** —— 实现方就在平台代码里，不经过目录发现、不可卸载，
 * 但走**与普通插件同一个注册面**（R6 工具 / R7 命令 / R8 钩子）。
 *
 * 为什么要有它：`callServer` 这类工具以前是 `tools.ts` 里的硬编码壳。硬编码壳的问题
 * 不是"多写几行"，而是**没有归属**：既不是内核能力，也不是任何插件的能力，于是
 * "谁提供这个工具、禁用谁会让它消失"这类问题无法回答。改成 inline 声明后，
 * 归属是数据（`id`），注册动作是统一的。
 *
 * 判定分界（design D16）：**实现方在不在平台代码里**。
 * - 在（`callServer`）→ inline，卸载即失效（这里没有"卸载"，它就是平台的一部分）
 * - 不在（`sendFileToUser` 靠 im、`postNotification` 靠 notifications）→ 随插件走，
 *   插件卸载 → 工具消失
 *
 * 白名单语义不变：`AgentConfig.serverBuiltinTools` 决定"这个 agent 能不能用"，
 * **声明 ≠ 开放**。
 */

import type { CapabilityIndexEntry } from '@pi-agent-platform/shared-types';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { CallMasterFn } from './tools.js';

/** inline 插件注册工具时的上下文（等价于 pi 扩展里的 `pi` + `host`）。 */
export interface InlineToolContext {
  sessionId: string;
  callMaster: CallMasterFn;
  capabilityIndex?: CapabilityIndexEntry[];
}

/**
 * inline 插件定义 —— 与目录插件的 `PluginDefinition` 同形，只是没有 `dir` 也没有装载点目录：
 * 它只有一个 `extension` 面（工具/命令/钩子都在 pi 扩展面上）。
 */
export interface InlinePluginDefinition {
  readonly id: string;
  readonly apiVersion: string;
  readonly extension: {
    /** R6 工具注册。返回的定义按 `serverBuiltinTools` 白名单过滤后才注入。 */
    tools?(ctx: InlineToolContext): ToolDefinition[];
  };
}

// ── callServer（从 tools.ts 迁来：实现方在平台代码里，故为 inline）────────────

const callServerSchema = {
  type: 'object',
  properties: {
    method: {
      type: 'string',
      description: 'Capability method name, e.g. "server.status", "agent.list", "session.update"',
    },
    params: {
      type: 'object',
      description: 'Method params — run the `detail` builtin first if unsure about the shape',
    },
  },
  required: ['method'],
  additionalProperties: false,
} as const;

interface CallServerParams {
  method: string;
  params?: Record<string, unknown>;
}

function buildCallServerDescription(index: CapabilityIndexEntry[]): string {
  const lines = index.map((e) => `- ${e.method} (${e.access}${e.scoped ? ', scoped' : ''}): ${e.summary}`);
  return [
    'Call host-server management capabilities (query server status, agents, sessions; update configs).',
    '',
    'Available methods (authorized for this session):',
    ...(lines.length > 0 ? lines : ['(no authorized business methods; `list` / `detail` still work)']),
    '',
    'Builtins:',
    '- list: grouped index of your authorized methods by module (server/agent/session/channel/config)',
    '- detail: full params schema + return shape + effect timing of one method — { method: "<name>" }',
    '',
    'Unknown method errors include the available method list.',
  ].join('\n');
}

function createCallServerTool(
  callMaster: CallMasterFn,
  index: CapabilityIndexEntry[],
): ToolDefinition {
  return {
    name: 'callServer',
    label: 'Call Server Capability',
    description: buildCallServerDescription(index),
    promptSnippet:
      'Query or manage the host server (server/agent/session capabilities). `list` enumerates your authorized methods by module; `detail` explains exact params of a method.',
    promptGuidelines: [
      'Use callServer for anything about the host platform: server status, listing/updating agents or sessions.',
      'Before calling a method you have not used this session, call `detail` with { method } to get its exact params and effect timing.',
      'Write capabilities (access: write) may be denied by policy — surface the error to the user instead of retrying blindly.',
    ],
    parameters: callServerSchema as any,
    execute: async (
      _toolCallId: string,
      params: CallServerParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) => {
      try {
        const result = await callMaster('plugin.admin.invoke', [params.method, params.params]);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }],
          details: result,
        };
      } catch (err) {
        // Control-plane errors are model-readable by design (unknown method lists
        // available methods; denials state the reason) — relay verbatim.
        const errorMsg = (err as Error).message;
        return {
          content: [{ type: 'text' as const, text: `callServer error: ${errorMsg}` }],
          details: { error: errorMsg },
        };
      }
    },
  };
}
/** 平台自带的 inline 插件清单。新增一个 = 在这里加一项（不需要目录、不需要 registry）。 */
export const INLINE_PLUGINS: readonly InlinePluginDefinition[] = [
  {
    id: 'callServer',
    apiVersion: '1',
    extension: {
      tools: ({ callMaster, capabilityIndex }) => [createCallServerTool(callMaster, capabilityIndex ?? [])],
    },
  },
];
