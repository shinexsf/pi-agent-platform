/**
 * Server-side tools injected into agent sessions — tools that talk to the
 * master via reverse IPC. Gated by `AgentConfig.serverBuiltinTools`
 * (undefined/null → none; [] → none; array → allowlist — explicit-agent-config),
 * independent from `builtinTools` (pi builtin tools only).
 *
 * 工具有两个来源（change: plugin-mechanism-v2 / D16）：
 * 1. **inline 插件**（`inline-plugins.ts`）：实现方在平台代码里、不可卸载 —— 如 `callServer`
 * 2. **尚未下沉的硬编码壳**：`sendFileToUser`（等 im 插件）/ `postNotification`（等 notifications 插件）
 *
 * 两者都受 `serverBuiltinTools` 白名单约束：**声明 ≠ 对该 agent 开放**。
 */

import type { CapabilityIndexEntry } from '@pi-agent-platform/shared-types';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { INLINE_PLUGINS } from './inline-plugins.js';

export type CallMasterFn = (method: string, args: unknown[]) => Promise<unknown>;

export interface ServerToolsOptions {
  /** Raw AgentConfig.serverBuiltinTools value (undefined/null → none — explicit-agent-config). */
  serverBuiltinTools?: string[];
  /** Compact capability index pushed by master at createSession — embedded into
   *  the callServer description so the model needs zero extra round-trips. */
  capabilityIndex?: CapabilityIndexEntry[];
}

// ── sendFileToUser（**待下沉**）───────────────────────────────────────────────
// 归属：im 插件（实现方是渠道网关，不是平台内核）。等 im 插件落地时随其 R6 迁过去，
// 迁走后本文件只剩 inline 声明 + postNotification 这个过渡壳。

/**
 * Parameters for sendFileToUser tool.
 * Defined as a plain object matching TypeBox's JSON Schema output format.
 */
const sendFileToUserSchema = {
  type: 'object',
  properties: {
    filePath: { type: 'string', description: 'Absolute path to the file to send' },
    fileName: { type: 'string', description: 'Friendly display name without extension (system auto-appends the correct extension from the actual file)' },
    caption: { type: 'string', description: 'Optional text caption to send with the file' },
  },
  required: ['filePath'],
  additionalProperties: false,
} as const;

interface SendFileToUserParams {
  filePath: string;
  fileName?: string;
  caption?: string;
}

function createSendFileToUserTool(
  sessionId: string,
  callMaster: CallMasterFn,
): ToolDefinition {
  return {
    name: 'sendFileToUser',
    label: 'Send File to User',
    description: 'Send a file or image to the user in the current chat',
    promptSnippet: 'Send a file or image to the user in the current chat',
    promptGuidelines: [
      'Use sendFileToUser to share generated files, images, charts, or documents with the user.',
      'The file must exist on disk. Use write tool first if needed.',
      'fileName is a display name without extension — the system auto-appends the correct extension from the actual file.',
    ],
    parameters: sendFileToUserSchema as any,
    execute: async (
      _toolCallId: string,
      params: SendFileToUserParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) => {
      try {
        const result = await callMaster('plugin.im.sendFile', [params]);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          details: result,
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

// ── postNotification ────────────────────────────────────────────────────────

/**
 * Write a message into the server notification inbox (change: trigger-scheduling;
 * renamed from `sendNotifyToUser` — the platform does not promise delivery).
 *
 * This is the ONLY way an agent can notify: notifications are never derived
 * from assistant messages. `sessionId` / `actionUrl` are filled by the master,
 * so the schema deliberately has no routing fields.
 */
const postNotificationSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short subject line (<= 120 chars)' },
    body: { type: 'string', description: 'Message body (plain text, no markdown)' },
    severity: {
      type: 'string',
      enum: ['info', 'warning', 'error'],
      description: 'info = FYI, warning = needs attention, error = something failed',
    },
  },
  required: ['title', 'body'],
  additionalProperties: false,
} as const;

interface PostNotificationParams {
  title: string;
  body: string;
  severity?: 'info' | 'warning' | 'error';
}

// ── postNotification（**待下沉**）────────────────────────────────────────────
// 归属：notifications 插件（实现方是通知收件箱模块）。
function createPostNotificationTool(
  sessionId: string,
  callMaster: CallMasterFn,
): ToolDefinition {
  return {
    name: 'postNotification',
    label: 'Post Notification',
    description:
      '向 server 通知中心发送一条消息（写进 /notifications 收件箱，供用户稍后查看；平台不做外部推送）',
    promptSnippet: 'Post a message to the server notification inbox',
    promptGuidelines: [
      'Use postNotification when the result matters while the user is away — scheduled/long tasks, failures, or explicit "tell me when done" requests.',
      'Do NOT use it for ordinary replies: if the user is chatting with you, answer in the conversation.',
      'severity: info for progress, warning for something the user should look at, error for failures.',
    ],
    parameters: postNotificationSchema as any,
    execute: async (
      _toolCallId: string,
      params: PostNotificationParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) => {
      try {
        const result = await callMaster('plugin.notifications.post', [params]);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result ?? { ok: true }) }],
          details: result ?? { ok: true },
        };
      } catch (err) {
        const errorMsg = `Failed to send notification: ${(err as Error).message}`;
        return {
          content: [{ type: 'text' as const, text: errorMsg }],
          details: { error: errorMsg },
        };
      }
    },
  };
}

// ── callServer ──────────────────────────────────────────────────────────────

/**
 * Parameters for callServer — the single meta-tool dispatching to the master
 * capability control plane (reverse IPC `invokeCapability`). Per-method
 * schemas are NOT expressible here; they are self-described via the builtin
 * `list` / `detail` methods and embedded in the description below.
 */
/** Build the tool description embedding the capability index (D2: zero-round-trip first use). */
// ── Server tools registry ───────────────────────────────────────────────────

/**
 * Create the server-side tools enabled for this session.
 * Gated by AgentConfig.serverBuiltinTools (undefined/null → none,
 * [] → none, array → exact allowlist). The master normalizes before spawn, so a
 * missing value already arrives as []; this fallback just keeps the worker honest.
 */
export function createServerTools(
  sessionId: string,
  callMaster: CallMasterFn,
  opts: ServerToolsOptions = {},
): ToolDefinition[] {
  const enabled = new Set(opts.serverBuiltinTools ?? []);
  const tools: ToolDefinition[] = [];
  if (enabled.has('sendFileToUser')) {
    tools.push(createSendFileToUserTool(sessionId, callMaster));
  }
  if (enabled.has('postNotification')) {
    tools.push(createPostNotificationTool(sessionId, callMaster));
  }
  // `callServer` 不再是硬编码壳：由 **inline 插件**声明（inline-plugins.ts），
  // 走与普通插件同一个注册面。白名单语义不变 —— 声明 ≠ 对该 agent 开放。
  for (const plugin of INLINE_PLUGINS) {
    const defs = plugin.extension.tools?.({ sessionId, callMaster, capabilityIndex: opts.capabilityIndex }) ?? [];
    for (const def of defs) {
      if (!enabled.has(def.name)) continue;
      tools.push(def);
    }
  }
  return tools;
}
