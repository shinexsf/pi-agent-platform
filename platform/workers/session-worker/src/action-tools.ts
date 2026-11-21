/**
 * 动作工具（change: plugin-actions-contract / D5）—— **平台接管 pi tool 注册**。
 *
 * 插件不再手写 `pi.registerTool` 的七行样板：server facet 用 `host.actions.define()` 声明
 * 一份 handler + `tool: {...}`，描述符随 spawn 下发（`WorkerPluginSpec.actions`），
 * worker 在这里统一注册成 pi 工具。
 *
 * `execute` 永远只有一条路径：`bridge.call('<id>.<action>', [params])` —— 反向方法回到同一个
 * handler。于是"工具看到的"与"service / HTTP / 反向方法看到的"是同一份业务逻辑，
 * 不会出现"工具能用、别的面行为不同"。
 *
 * 三件平台必须自己做的事（pi 不管）：
 * 1. **名字唯一性**：pi 的工具注册表是静默"先到先得"（重名后者被丢弃，不报错）——
 *    所以冲突必须在这里显式拒绝 + warn，不许静默改名。
 * 2. **入参校验**：pi 不按 schema 校验工具参数；校验失败要给模型一个
 *    `isError` 结果（它能读懂并改参数），而不是让 handler 抛栈。
 * 3. **`deferred` 的前提**：`exposure: 'deferred'` 的工具要靠 `tool_search` 才能被模型
 *    找到；会话没开 `tool_search` 时它**对模型完全隐形**，所以打一条 warn 而不是静默。
 */

import type { ToolDefinition, ToolExposure, ToolNamespace } from '@earendil-works/pi-coding-agent';
import { validateParams, type ActionDescriptor, type WorkerPluginSpec } from '@pi-agent-platform/ipc-protocol';
import type { CallMasterFn } from './tools.js';

/** worker 侧的 logger 形状（`pino` 实例；这里只用到 warn/error/debug）。 */
export interface ActionToolLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  /** pi 的 `AgentToolResult` 要求有个 details 槽（这里不放业务数据）。 */
  details: Record<string, never>;
  isError?: boolean;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 把 IPC 契约里的 namespace 声明转成 pi 的形状（字符串 → `{ name }`）。 */
function toNamespace(ns: ActionDescriptor['tool']['namespace']): ToolNamespace | undefined {
  if (!ns) return undefined;
  return typeof ns === 'string' ? { name: ns } : { name: ns.name, ...(ns.instructions ? { instructions: ns.instructions } : {}) };
}

/**
 * 生成某会话的动作工具。
 *
 * `taken` 是**已被占用的工具名**（inline 工具的 + 之前注册的动作工具的），
 * 冲突者在这里被跳过并 warn —— 与 pi 的静默先到先得相反：可发现，且不偷偷改名。
 */
export function createActionTools(
  plugins: readonly WorkerPluginSpec[],
  callMaster: CallMasterFn,
  taken: Set<string>,
  logger: ActionToolLogger,
  sessionId: string,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const deferred: string[] = [];

  for (const plugin of plugins) {
    if (!plugin.enabled || !plugin.actions?.length) continue;
    for (const descriptor of plugin.actions) {
      const name = descriptor.tool.name;
      if (taken.has(name)) {
        logger.warn(
          { sessionId, pluginId: plugin.id, action: descriptor.action, tool: name },
          '动作工具名冲突：后者不注册（pi 的工具表是静默先到先得，这里显式拒绝）',
        );
        continue;
      }
      taken.add(name);

      const exposure = (descriptor.tool.exposure ?? 'deferred') as ToolExposure;
      if (exposure === 'deferred') deferred.push(name);

      const method = `${plugin.id}.${descriptor.action}`;
      tools.push({
        name,
        label: descriptor.tool.description.slice(0, 40),
        description: descriptor.tool.description,
        parameters: descriptor.params as never,
        exposure,
        ...(toNamespace(descriptor.tool.namespace) ? { namespace: toNamespace(descriptor.tool.namespace)! } : {}),
        ...(descriptor.tool.annotations ? { annotations: descriptor.tool.annotations as never } : {}),
        ...(descriptor.tool.promptSnippet ? { promptSnippet: descriptor.tool.promptSnippet } : {}),
        ...(descriptor.tool.promptGuidelines ? { promptGuidelines: descriptor.tool.promptGuidelines } : {}),
        execute: async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
          // 校验前置：模型给错参数时立刻拿到 isError（不用绕一圈 master 再回来）。
          const check = validateParams(descriptor.params, params ?? {});
          if (!check.ok) {
            return {
              isError: true,
              details: {},
              content: [{ type: 'text', text: `参数校验失败：${check.message}` }],
            };
          }
          try {
            const result = await callMaster(method, [params ?? {}], plugin.id);
            return { details: {}, content: [{ type: 'text', text: asText(result ?? 'ok') }] };
          } catch (err) {
            return {
              isError: true,
              details: {},
              content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
            };
          }
        },
      });
    }
  }

  logger.debug({ sessionId, tools: tools.map((t) => t.name) }, `动作工具 ${tools.length} 个`);
  return tools;
}

/**
 * `deferred` 工具的可用性检查（任务 3.7）。
 *
 * pi 的同类告警只覆盖"MCP 工具有 deferred 但没开 tool_search"，动作工具在它视野之外 ——
 * 缺了这条，症状是"模型说它没有这个工具"，而日志里一个字都没有。
 */
export function warnDeferredWithoutToolSearch(
  deferredTools: readonly string[],
  builtinTools: readonly string[] | undefined,
  logger: ActionToolLogger,
  sessionId: string,
): void {
  if (deferredTools.length === 0) return;
  if ((builtinTools ?? []).includes('tool_search')) return;
  logger.warn(
    { sessionId, tools: deferredTools },
    '本会话有 deferred 动作工具，但 builtinTools 未启用 tool_search —— 这些工具对模型不可见',
  );
}
