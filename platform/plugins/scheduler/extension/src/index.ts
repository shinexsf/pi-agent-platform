/**
 * extension facet —— 定时任务给 **agent** 的工具（R6）。
 *
 * 为什么这里是工具而不是 capability：旧版 agent 要排日程得走 `callServer` →
 * `trigger.create`（双闸：`serverBuiltinTools` 勾 `callServer` + `capabilities` allowlist）。
 * 现在定时任务是插件，**插件对该会话生效 → agent 自动获得工具和 skill**，
 * 不需要在 agent 配置里勾任何一项。归属从"能力控制面"挪到"插件生效面"。
 *
 * 约定：工具只做"创建 / 列出 / 取消"，**不返回运行结果** —— 运行是异步的，
 * 而 run 的成败语义是"消息有没有送进 agent"（见 server facet）。
 */

import type { PiExtensionApi, PluginWorkerBridge } from '@pi-agent-platform/plugin-types';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * 平台**不重新声明** pi 的 ExtensionAPI（避免跟着 pi 版本漂移），它到插件手里是
 * `PiExtensionApi`（= unknown）。所以这里只声明本插件真正用到的那一小块，
 * 其余一概不碰 —— 契约面越小，pi 升级时越不会连带炸。
 */
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
    // `bridge.call` 是可选的（未启用 bridged 模式时没有）—— 没有它这个工具就没意义，
    // 明确告警而不是注册一个必然失败的工具。
    if (!bridge?.call) {
      bridge?.log('warn', 'plugin.scheduler: bridge.call 不可用，schedule_task 未注册');
      return;
    }
    const call = bridge.call.bind(bridge);
    api.registerTool({
      name: 'schedule_task',
      label: '定时任务',
      description:
        '创建 / 查看 / 取消定时任务：按 cron 表达式或一个具体时刻，把一段指令在指定会话里自动执行。' +
        '只管理任务本身，不返回执行结果（任务会在到点时独立运行）。',
      promptSnippet:
        'schedule_task: 创建/查看/取消定时任务（cron 或一次性时刻）；只在用户明确要求"定时/每天/提醒"时使用',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'list', 'cancel'],
            description: 'create 创建；list 列出当前工作区/agent 的定时任务；cancel 按 taskId 取消',
          },
          // ── create ──
          name: { type: 'string', description: '任务名（用于列表与通知，简短）' },
          prompt: { type: 'string', description: '到点时要执行的指令（就是你在那个会话里该做的事）' },
          scheduleKind: {
            type: 'string',
            enum: ['cron', 'once'],
            description: 'cron = 重复（需 cronExpr + timezone）；once = 一次性（需 at）',
          },
          cronExpr: {
            type: 'string',
            description: '5 段 cron（分 时 日 月 周），最小间隔 5 分钟，例：`0 9 * * *` = 每天 9:00',
          },
          timezone: { type: 'string', description: 'IANA 时区，例：`Asia/Shanghai`。缺省 UTC' },
          at: { type: 'string', description: '一次性任务的时刻，ISO 8601（例：`2026-11-20T09:00:00+08:00`）' },
          sessionMode: {
            type: 'string',
            enum: ['new', 'reuse'],
            description: 'new = 每次触发新建会话（默认）；reuse = 固定复用一个会话（不传 sessionId 时首次触发自动创建）',
          },
          sessionId: { type: 'string', description: 'reuse 模式下的目标会话 id；只建议复用当前会话时传' },
          busyPolicy: {
            type: 'string',
            enum: ['followUp', 'steer', 'skip'],
            description:
              '到点时 agent 正在跑怎么办：followUp 排队（默认，不丢这一轮）/ steer 插队 / skip 这一次不投。' +
              '高频任务（间隔小于单轮耗时）建议 skip',
          },
          // ── cancel ──
          taskId: { type: 'string', description: 'cancel 时的任务 id' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, params: Record<string, unknown>) => {
        const action = String(params?.action ?? '');

        if (action === 'list') {
          const res = (await call('plugin.scheduler.task.list', [{}])) as { items?: unknown[] };
          return text(`当前定时任务 ${res.items?.length ?? 0} 个：\n${JSON.stringify(res.items ?? [], null, 2)}`);
        }

        if (action === 'cancel') {
          if (!params?.taskId) return text('cancel 需要 taskId（可先 action:"list" 查看）', true);
          await call('plugin.scheduler.task.delete', [{ taskId: params.taskId }]);
          return text(`已取消任务 ${params.taskId}`);
        }

        if (action !== 'create') return text(`未知 action：${action}`, true);
        if (!params?.prompt) return text('create 需要 prompt（到点要执行的指令）', true);

        const scheduleKind = params.scheduleKind === 'once' ? 'once' : 'cron';
        let at: number | undefined;
        if (scheduleKind === 'once') {
          if (!params.at) return text('一次性任务需要 at（ISO 8601 时间）', true);
          const parsed = Date.parse(String(params.at));
          if (Number.isNaN(parsed)) return text(`at 不是合法时间：${params.at}`, true);
          at = parsed;
        }

        try {
          const task = (await call('plugin.scheduler.task.create', [
            {
              // agentId 由 server 侧补（ctx 里带着调用方会话），这里不猜。
              name: params.name,
              prompt: params.prompt,
              scheduleKind,
              cronExpr: params.cronExpr,
              timezone: params.timezone,
              at,
              sessionMode: params.sessionMode,
              sessionId: params.sessionMode === 'reuse' ? params.sessionId : undefined,
              busyPolicy: params.busyPolicy,
            },
          ])) as { id?: string; name?: string; nextAt?: number };

          const when = task.nextAt
            ? new Date(task.nextAt).toLocaleString('zh-CN', { timeZone: String(params.timezone ?? 'UTC') })
            : '未知';
          return text(`已创建定时任务「${task.name ?? params.name ?? ''}」（id=${task.id}），下次运行：${when}`);
        } catch (err) {
          return text(`创建失败：${err instanceof Error ? err.message : String(err)}`, true);
        }
      },
    });

    bridge.log('info', 'extension facet registered schedule_task');
  },
};

/** worker 所在机器的时区（没有参数时用它兜底，绝不用 UTC）。 */
function systemTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function text(value: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}
