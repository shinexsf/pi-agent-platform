/**
 * Server-side tools injected into agent sessions —— 全部来自 **inline 插件**
 * （`inline-plugins.ts`），本文件只做聚合。
 *
 * 曾经的"硬编码壳 + `serverBuiltinTools` 逐 agent 白名单"已经退役：
 * 工具归属谁，就该由谁的开关决定 —— **插件生效 → 工具自动注入**。
 *
 * 现在清单是空的（`sendFileToUser` 已随 `im` 插件迁到动作，工具名不变）。
 * 模板与会话仍走这条聚合，以便下一个 inline 工具直接接入。
 */

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { INLINE_PLUGINS } from './inline-plugins.js';

/** Reverse-call chokepoint. `source` is injected by the caller's bridge (plugin id /
 *  `inline`) and forwarded to master for ownership checks — plugin code cannot set it. */
export type CallMasterFn = (method: string, args: unknown[], source?: string) => Promise<unknown>;

export interface ServerToolsOptions {
  /** 预留：目前 inline 工具不需要任何自 spawn 参数（管理动作已迁到 `admin` 插件）。 */
  nothing?: never;
}

// ── Server tools registry ───────────────────────────────────────────────────

/**
 * Create the server-side tools for this session.
 *
 * 没有逐 agent 白名单了：**能不能拿到某个工具 = 提供它的插件对这个会话是否生效**。
 */
export function createServerTools(
  sessionId: string,
  callMaster: CallMasterFn,
  opts: ServerToolsOptions = {},
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const plugin of INLINE_PLUGINS) {
    const defs = plugin.extension.tools?.({ sessionId, callMaster }) ?? [];
    tools.push(...defs);
  }
  return tools;
}
