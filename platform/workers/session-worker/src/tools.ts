/**
 * Server-side tools injected into agent sessions —— 全部来自 **inline 插件**
 * （`inline-plugins.ts`），本文件只做聚合。
 *
 * 曾经的"硬编码壳 + `serverBuiltinTools` 逐 agent 白名单"已经退役：
 * 工具归属谁，就该由谁的开关决定 —— **插件生效 → 工具自动注入**。
 *
 * - `callServer`：inline 插件；agent 没有任何授权能力时**不注入**（没内容的自述工具是噪音）
 * - `sendFileToUser`：inline 插件（实现方是 im 网关，随 im 插件落地后迁走）
 * - `postNotification`：notifications 插件的 extension facet（插件停用 → 工具消失）
 */

import type { CapabilityIndexEntry } from '@pi-agent-platform/shared-types';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { INLINE_PLUGINS } from './inline-plugins.js';

export type CallMasterFn = (method: string, args: unknown[]) => Promise<unknown>;

export interface ServerToolsOptions {
  /** Compact capability index pushed by master at createSession — embedded into
   *  the callServer description so the model needs zero extra round-trips.
   *  为空时 callServer **不注入**。 */
  capabilityIndex?: CapabilityIndexEntry[];
}

// ── Server tools registry ───────────────────────────────────────────────────

/**
 * Create the server-side tools for this session.
 *
 * 没有逐 agent 白名单了：**能不能拿到某个工具 = 提供它的插件对这个会话是否生效**。
 * 插件自己可以再收窄（`callServer` 在没有任何授权能力时返回空），
 * 但那是工具的自我判断，不是平台的开关。
 */
export function createServerTools(
  sessionId: string,
  callMaster: CallMasterFn,
  opts: ServerToolsOptions = {},
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const plugin of INLINE_PLUGINS) {
    const defs = plugin.extension.tools?.({ sessionId, callMaster, capabilityIndex: opts.capabilityIndex }) ?? [];
    tools.push(...defs);
  }
  return tools;
}
