/**
 * extension facet —— webhook 给 **agent** 的工具（R6）。
 *
 * 为什么 agent 可以建外部入口（而定时任务只管自己）：用户明确要这个能力 ——
 * "你自己接个 webhook 吧"是常见诉求（CI 失败、issue 打开、监控告警）。
 * 风险靠**归属校验**控制而不是靠不给能力：agent 只能建/删自己 agent 的 hook，
 * 建出来的入口带 secret，只出现在它自己的上下文里。
 *
 * 工具只做 create / list / delete —— **没有 update**：改一个已经交给外部系统的
 * 入口（尤其是 prompt）应该由人来做，模型能做的最小集刚好够"现在立刻接上"。
 */

import type { PiExtensionApi, PluginWorkerBridge } from '@pi-agent-platform/plugin-types';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** 平台不重新声明 pi 的 ExtensionAPI（避免跟着 pi 版本漂移），只声明用到的那一块。 */
interface PiToolRegistrar {
  registerTool(def: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    parameters: Record<string, unknown>;
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>;
  }): void;
}

export default {
  async init(pi: PiExtensionApi, { bridge }: { bridge: PluginWorkerBridge }) {
    const api = pi as unknown as PiToolRegistrar;
    if (!bridge?.call) {
      bridge?.log('warn', 'plugin.webhook: bridge.call 不可用，manage_webhook 未注册');
      return;
    }
    const call = bridge.call.bind(bridge);

    api.registerTool({
      name: 'manage_webhook',
      label: 'Webhook',
      description:
        '创建 / 查看 / 删除 webhook 入口：外部系统 POST 到该 URL 时，平台会把你写的指令送进一个会话执行。' +
        '创建后返回完整 URL 与 Bearer secret —— 把这两个交给要调用的一方即可。只管理入口本身，不返回执行结果。',
      promptSnippet:
        'manage_webhook: 创建/查看/删除 webhook 入口（外部系统 POST 触发）；只在用户明确要"接外部事件"时使用',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'delete'], description: 'create 创建；list 列出；delete 删除' },
          // ── create ──
          name: { type: 'string', description: '短名（出现在列表与失败通知里）' },
          prompt: { type: 'string', description: '事件到达时要执行的指令（就是你在那个会话里该做的事）' },
          sessionMode: {
            type: 'string',
            enum: ['new', 'reuse'],
            description: 'new = 每个事件新建会话（默认）；reuse = 固定复用一个会话（不传 sessionId 时首次自动创建）',
          },
          sessionId: { type: 'string', description: 'reuse 模式下的目标会话 id；只建议复用当前会话时传' },
          busyPolicy: {
            type: 'string',
            enum: ['followUp', 'steer', 'skip'],
            description: '收到事件时你正在跑怎么办：followUp 排队（默认）/ steer 插队 / skip 这次不投',
          },
          // ── delete ──
          hookId: { type: 'string', description: 'delete 时的 hook id' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const action = String(params?.action ?? '');

        if (action === 'list') {
          const res = (await call('plugin.webhook.hook.list', [{}])) as { items?: unknown[] };
          const items = (res.items ?? []) as Array<{ id: string; name: string; enabled: boolean }>;
          if (items.length === 0) return text('当前没有 webhook 入口。');
          return text(
            `当前 webhook ${items.length} 个：\n${items
              .map((i) => `- ${i.id} · ${i.name}${i.enabled ? '' : '（已停用）'}`)
              .join('\n')}`,
          );
        }

        if (action === 'delete') {
          if (!params?.hookId) return text('delete 需要 hookId（可先 action:"list" 查看）', true);
          await call('plugin.webhook.hook.delete', [{ hookId: params.hookId }]);
          return text(`已删除 webhook ${params.hookId}`);
        }

        if (action !== 'create') return text(`未知 action：${action}`, true);
        if (!params?.prompt) return text('create 需要 prompt（事件到达时要执行的指令）', true);

        try {
          const res = (await call('plugin.webhook.hook.create', [
            {
              // agentId 由 server 侧按调用方会话补，这里不猜。
              name: params.name,
              prompt: params.prompt,
              sessionMode: params.sessionMode,
              sessionId: params.sessionMode === 'reuse' ? params.sessionId : undefined,
              busyPolicy: params.busyPolicy,
            },
          ])) as { hook?: { id?: string; name?: string; secret?: string }; url?: string };

          const hook = res.hook ?? {};
          return text(
            [
              `已创建 webhook「${hook.name ?? params.name ?? ''}」（id=${hook.id}）。`,
              '',
              `URL：${res.url ?? ''}`,
              `Secret：${hook.secret ?? ''}`,
              '',
              '调用方式：',
              '```',
              `curl -X POST <你的服务地址>${res.url ?? ''} \\`,
              `  -H "Authorization: Bearer ${hook.secret ?? ''}" \\`,
              '  -H "Content-Type: application/json" \\',
              `  -d '{"event":"deploy.failed","service":"api"}'`,
              '```',
              'body 原样进 <data>.payload（请求头信息在 _meta）；需要去重就让对方带 `Idempotency-Key` 头。',
            ].join('\n'),
          );
        } catch (err) {
          return text(`创建失败：${err instanceof Error ? err.message : String(err)}`, true);
        }
      },
    });

    bridge.log('info', 'extension facet registered manage_webhook');
  },
};

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}
