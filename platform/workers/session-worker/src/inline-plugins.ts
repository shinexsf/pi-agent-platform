/**
 * inline 插件（change: plugin-mechanism-v2 / D16）。
 *
 * 定义：**编译进平台的插件** —— 实现方就在平台代码里，不经过目录发现、不可卸载，
 * 但走**与普通插件同一个注册面**（R6 工具 / R7 命令 / R8 钩子）。
 *
 * 为什么要有它：工具以前是 `tools.ts` 里的硬编码壳。硬编码壳的问题不是"多写几行"，
 * 而是**没有归属**：既不是内核能力，也不是任何插件的能力，于是"谁提供这个工具、
 * 禁用谁会让它消失"这类问题无法回答。改成 inline 声明后，归属是数据（`id`）。
 *
 * 判定分界（design D16）：**实现方在不在平台代码里**。
 * - 在（`sendFileToUser` 的网关侧）→ inline，随平台走
 * - 不在（`postNotification` 的收件箱、im 渠道能力、平台管理动作）→ 随**那个插件**走，
 *   插件停用 → 工具消失（`admin` 插件就是这样接管了原 `callServer` 的 8 个能力）
 *
 * 没有逐 agent 白名单了（`serverBuiltinTools` 已退役）：**插件生效 → 工具自动注入**。
 */

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { CallMasterFn } from './tools.js';

/** inline 插件注册工具时的上下文（等价于 pi 扩展里的 `pi` + `host`）。 */
export interface InlineToolContext {
  sessionId: string;
  callMaster: CallMasterFn;
}

/**
 * inline 插件定义 —— 与目录插件的 `PluginDefinition` 同形，只是没有 `dir` 也没有装载点目录：
 * 它只有一个 `extension` 面（工具/命令/钩子都在 pi 扩展面上）。
 */
export interface InlinePluginDefinition {
  readonly id: string;
  readonly apiVersion: string;
  readonly extension: {
    /** R6 工具注册。返回什么就注入什么（插件自己决定要不要收窄）。 */
    tools?(ctx: InlineToolContext): ToolDefinition[];
  };
}

// ── sendFileToUser（inline：实现方是 im 网关，属平台代码）─────────────────────
// 归属：im 插件（等它落地时随 R6 迁过去，届时 inline 这一项删除）。
// 现在没有逐 agent 开关了，所以它对所有会话可用；没有 IM 渠道时调用会得到反向方法
// 不存在的错误 —— 那是运行期事实，不是配置问题。

const sendFileToUserSchema = {
  type: 'object',
  properties: {
    filePath: { type: 'string', description: 'Absolute path to the file to send' },
    fileName: {
      type: 'string',
      description: 'Friendly display name without extension (system auto-appends the correct extension from the actual file)',
    },
  },
  required: ['filePath'],
  additionalProperties: false,
} as const;

interface SendFileToUserParams {
  filePath: string;
  fileName?: string;
}

function createSendFileToUserTool(sessionId: string, callMaster: CallMasterFn): ToolDefinition {
  return {
    name: 'sendFileToUser',
    label: 'Send File To User',
    description:
      'Send a file to the user through the active IM channel (QQ / WeChat). Use absolute paths inside the workspace.',
    promptSnippet: 'Send a file to the user via IM',
    parameters: sendFileToUserSchema as any,
    execute: async (
      _toolCallId: string,
      params: SendFileToUserParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) => {
      try {
        const result = await callMaster('im.sendFile', [
          { sessionId, filePath: params.filePath, fileName: params.fileName },
        ]);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result ?? { ok: true }) }],
          details: result ?? { ok: true },
        };
      } catch (err) {
        const errorMsg = `Failed to send file: ${(err as Error).message}`;
        return {
          content: [{ type: 'text' as const, text: errorMsg }],
          details: { error: errorMsg },
        };
      }
    },
  };
}

/** 平台自带的 inline 插件清单。新增一个 = 在这里加一项（不需要目录、不需要 registry）。 */
export const INLINE_PLUGINS: readonly InlinePluginDefinition[] = [
  {
    id: 'sendFileToUser',
    apiVersion: '1',
    extension: {
      tools: ({ sessionId, callMaster }) => [createSendFileToUserTool(sessionId, callMaster)],
    },
  },
];
