/**
 * extension facet —— 通知插件给 **agent** 的工具（R6）：`postNotification`。
 *
 * 以前它是 worker 里的硬编码壳（`workers/session-worker/src/tools.ts`），归属不成立：
 * 实现在通知插件里，但工具由平台无条件注册，于是"禁用通知插件"和"agent 还有这个工具"
 * 是两套互相矛盾的开关。现在随插件走：**插件生效 → 工具自动注入；插件停用 → 工具消失**。
 *
 * 注意：agent 侧仍没有"路由"字段 —— `sessionId` / `actionUrl` 由 master 按调用方会话填，
 * 模型传了也忽略。平台只把一条消息写进收件箱，**不承诺送达、不对外推送**。
 */

import type { PiExtensionApi, PluginWorkerBridge } from '@pi-agent-platform/plugin-types';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details?: unknown;
}

interface PiToolRegistrar {
  registerTool(def: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;
  }): void;
}

const parameters = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '短标题（<= 120 字符）' },
    body: { type: 'string', description: '正文（纯文本，不要 markdown）' },
    severity: {
      type: 'string',
      enum: ['info', 'warning', 'error'],
      description: 'info = 告知，warning = 需要看一眼，error = 出错了',
    },
  },
  required: ['title', 'body'],
  additionalProperties: false,
} as const;

export default {
  async init(pi: PiExtensionApi, { bridge }: { bridge: PluginWorkerBridge }) {
    const api = pi as unknown as PiToolRegistrar;
    if (!bridge?.call) {
      bridge?.log('warn', 'plugin.notifications: bridge.call 不可用，postNotification 未注册');
      return;
    }
    const call = bridge.call.bind(bridge);

    api.registerTool({
      name: 'postNotification',
      label: 'Post Notification',
      description:
        '向 server 通知中心发送一条消息（写进收件箱，供用户稍后查看；平台不做外部推送）',
      promptSnippet: 'Post a message to the server notification inbox',
      promptGuidelines: [
        'Use postNotification when the result matters while the user is away — scheduled/long tasks, failures, or explicit "tell me when done" requests.',
        'Do NOT use it for ordinary replies: if the user is chatting with you, answer in the conversation.',
        'severity: info for progress, warning for something the user should look at, error for failures.',
      ],
      parameters: parameters as unknown as Record<string, unknown>,
      execute: async (_toolCallId, params) => {
        try {
          const result = await call('plugin.notifications.post', [params]);
          return {
            content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }) }],
            details: result ?? { ok: true },
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text', text: `Failed to send notification: ${message}` }],
            details: { error: message },
          };
        }
      },
    });

    bridge.log('info', 'extension facet registered postNotification');
  },
};
