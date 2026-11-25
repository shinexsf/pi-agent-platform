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
 * - 在（`callServer` 这类直接操作平台内部的）→ inline，随平台走
 * - 不在（`postNotification` 的收件箱、im 渠道能力、平台管理动作）→ 随**那个插件**走，
 *   插件停用 → 工具消失（`admin` 插件就是这样接管了原 `callServer` 的 8 个能力）
 *
 * **当前清单为空**：最后一项 `sendFileToUser` 已随 `im` 插件落地迁走（现在是 `im.sendFile`
 * 动作，工具名不变）—— 留两份同名工具没有意义：inline 先占名、动作侧被跳过并 warn。
 * 通道本身保留：下一个"实现方就在平台代码里"的工具仍该用它，而不是回到硬编码壳。
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

// ── sendFileToUser（已迁走 → im 插件）───────────────────────────────────────────
// 它曾经是这里的 inline 插件（当时的 im 网关在平台代码里）。im 下沉为插件后，工具随
// `im.sendFile` 动作走 —— 两份同名工具没意义（inline 先占名、动作侧被跳过并 warn），
// 所以删掉。归属台账见 `doc/architecture/pi-agent-server_plugins-runtime.md`。


/** 平台自带的 inline 插件清单（当前为空；见上面 sendFileToUser 的迁移说明）。 */
export const INLINE_PLUGINS: readonly InlinePluginDefinition[] = [];
