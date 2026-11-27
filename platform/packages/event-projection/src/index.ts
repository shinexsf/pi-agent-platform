/**
 * UI 投影：pi 原生事件 → 客户端 DTO。
 *
 * 为什么独立成包（不在 core 里，也不在某个入口里）：
 * - core 不该知道 UI 长什么样（"内核"≠"HTTP 后端"）
 * - HTTP 入口与未来的桌面端入口消费**同一套 Vue 前端**，所以 DTO 契约必须只有
 *   一份实现；放进某一个入口里，第二个入口就得复制一份，两份必然漂移
 *
 * 职责边界（只有这一件事）：回答"这条事件在客户端长什么样"。
 * 事件的**去向**（改名成插件前缀、过滤内部事件）与**限流**（大小 / 频率上限）
 * 属于路由与准入，留在入口侧。
 *
 * 投影器是 per-session 有状态实例：它持有累积文本、messageId、计时等跨事件状态，
 * 所以不是纯函数。消费者应为一个会话建一个实例，会话终结时丢弃。
 */

import type { MessageDeltaDTO, MessageRole, MessageUsageDTO, ToolCallDTO } from '@pi-agent-platform/shared-types';
import type { WorkerEvent } from '@pi-agent-platform/ipc-protocol';

/** 投影结果：客户端契约里的一个事件（名字 + 载荷）。 */
export interface ProjectedEvent {
  /** SSE / IPC 上面向客户端的事件名。 */
  name: string;
  data: unknown;
}

/**
 * 每条 worker 事件的 `data` 形状：pi 原生事件对象，原样转发。
 * 这里只声明投影器实际读取的字段，其余字段透传时不关心。
 */
interface RawEvent {
  type?: string;
  message?: Record<string, unknown>;
  parentId?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: { content?: unknown };
  partialResult?: unknown;
  isError?: boolean;
  durationMs?: number;
  /** pi `agent_end`：本轮结束后是否将自动重试。 */
  willRetry?: boolean;
  /** pi `agent_settled`。 */
  aborted?: boolean;
  /** pi `queue_update`。 */
  steering?: readonly string[];
  followUp?: readonly string[];
  /** pi `auto_retry_*`。 */
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
  errorMessage?: string;
  success?: boolean;
  finalError?: string;
  /** 平台合成 `session_branch`：当前 / 之前的分支末端。 */
  leafId?: string | null;
  oldLeafId?: string | null;
  /** pi `compaction_*`。 */
  reason?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  summary?: string;
}

export interface SessionProjector {
  /**
   * 投影一条事件。
   *
   * 返回 `null` 表示这条事件不进客户端流（平台内部事件、插件事件——后者的
   * 路由与限流在入口侧，不归投影）。返回 `ProjectedEvent[]` 的情况目前不存在，
   * 保留单条返回以免调用方过早假设。
   */
  project(event: WorkerEvent): ProjectedEvent | null;
  /** 会话终结时调用；丢弃累积状态。 */
  dispose(): void;
}

/** Read role from a pi message block. */
function roleOf(role: unknown): MessageRole {
  if (role === 'user' || role === 'assistant' || role === 'toolResult') return role;
  return 'assistant';
}

/**
 * 提取 content 数组里的 **text** 块（不含 thinking，thinking 走 extractThinking）。
 * 这样调用方可以分别处理正文与思考，不会把思考文本重复塞进正文。
 */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => {
      const block = b as { type: string; text?: unknown };
      return typeof block.text === 'string' ? block.text : '';
    })
    .filter((s) => s.length > 0)
    .join('');
}

/** 提取 content 数组里的 **thinking** 块。 */
function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'thinking')
    .map((b) => {
      const block = b as { type: string; thinking?: unknown };
      return typeof block.thinking === 'string' ? block.thinking : '';
    })
    .filter((s) => s.length > 0)
    .join('');
}

/** 提取 content 数组里的 toolCall 块。 */
function extractToolCalls(content: unknown): ToolCallDTO[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const calls: ToolCallDTO[] = [];
  for (const b of content) {
    if (b && typeof b === 'object' && 'type' in b && (b as { type: string }).type === 'toolCall') {
      const t = b as { id?: string; name?: string; arguments?: unknown };
      if (t.id && t.name) {
        calls.push({
          id: t.id,
          name: t.name,
          args: (t.arguments as Record<string, unknown> | undefined) ?? {},
        });
      }
    }
  }
  return calls.length > 0 ? calls : undefined;
}

/**
 * pi-ai `Usage` → DTO。没有用量时返回 undefined（user / toolResult 消息），
 * 让客户端能区分"没有数据"与"零成本"。
 */
function extractUsage(raw: unknown): MessageUsageDTO | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  if (typeof u.input !== 'number' && typeof u.output !== 'number') return undefined;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const cost = (u.cost && typeof u.cost === 'object' ? u.cost : {}) as Record<string, unknown>;
  return {
    input: num(u.input),
    output: num(u.output),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    ...(typeof u.reasoning === 'number' ? { reasoning: u.reasoning } : {}),
    totalTokens: num(u.totalTokens),
    cost: {
      input: num(cost.input),
      output: num(cost.output),
      cacheRead: num(cost.cacheRead),
      cacheWrite: num(cost.cacheWrite),
      total: num(cost.total),
    },
  };
}

/**
 * 创建一个会话级投影器。
 *
 * messageId 由投影器自己分配（`msg-N`）：pi 的原始事件不带稳定 id，而这个 id 是
 * 客户端把 `message_start` / `message_update` / `message_end` 串成一条消息的唯一依据。
 * 分配规则只看"这是本会话的第几次 message_start"，所以不需要 worker 传任何东西。
 */
export function createSessionProjector(): SessionProjector {
  let messageCounter = 0;
  let currentMessageId: string | null = null;
  /** 当前消息的墙钟起点（用于 message_end 的 durationMs）。 */
  let messageStartedAt: number | null = null;

  const fromMessage = (raw: RawEvent, messageId: string, parentId?: string): MessageDeltaDTO => {
    const msg = raw.message ?? {};
    const role = roleOf(msg.role);
    const content = extractText(msg.content);
    const thinking = extractThinking(msg.content);
    return {
      messageId,
      parentId,
      role,
      content: content || undefined,
      thinking: thinking || undefined,
      toolCalls: role === 'assistant' ? extractToolCalls(msg.content) : undefined,
      toolCallId: msg.toolCallId as string | undefined,
      toolName: msg.toolName as string | undefined,
      model: msg.model as string | undefined,
      provider: msg.provider as string | undefined,
      stopReason: msg.stopReason as string | undefined,
      // 助手消息的 provider 失败文本。pi 只在这里给原因（失败的消息没有 content 块，
      // 也没有 error 事件）；不转发它，客户端就是一个空气泡。
      errorMessage: typeof msg.errorMessage === 'string' ? msg.errorMessage : undefined,
      // toolResult 的失败标记是 message 顶层字段，不在 content 里、也不在 stopReason 里。
      isError: typeof msg.isError === 'boolean' ? msg.isError : undefined,
      usage: role === 'assistant' ? extractUsage(msg.usage) : undefined,
    };
  };

  return {
    project(event: WorkerEvent): ProjectedEvent | null {
      const name = event.event;
      const raw = (event.data ?? {}) as RawEvent;

      switch (name) {
        case 'agent_start':
          return { name: 'agent_start', data: { startedAt: Date.now() } };

        case 'agent_settled':
          return { name: 'agent_settled', data: { aborted: Boolean(raw.aborted) } };

        case 'queue_update':
          return {
            name: 'queue_update',
            data: {
              steering: raw.steering ?? [],
              followUp: raw.followUp ?? [],
            },
          };

        case 'auto_retry_start':
          return {
            name: 'auto_retry_start',
            data: {
              attempt: raw.attempt ?? 0,
              maxAttempts: raw.maxAttempts ?? 0,
              delayMs: raw.delayMs ?? 0,
              ...(raw.errorMessage ? { errorMessage: raw.errorMessage } : {}),
            },
          };

        case 'auto_retry_end':
          return {
            name: 'auto_retry_end',
            data: {
              success: Boolean(raw.success),
              attempt: raw.attempt ?? 0,
              ...(raw.finalError ? { finalError: raw.finalError } : {}),
            },
          };

        case 'message_start':
        case 'message_update':
        case 'message_end': {
          if (name === 'message_start') {
            currentMessageId = `msg-${++messageCounter}`;
            messageStartedAt = Date.now();
          }
          const messageId = currentMessageId ?? 'msg-0';
          const delta = fromMessage(raw, messageId, raw.parentId);
          const isEnd = name === 'message_end';
          if (isEnd) {
            if (messageStartedAt !== null) {
              delta.durationMs = Math.max(0, Date.now() - messageStartedAt);
            }
            currentMessageId = null;
            messageStartedAt = null;
          }
          return { name: isEnd ? 'message_end' : 'message_update', data: delta };
        }

        case 'tool_execution_start':
          return {
            name: 'tool_call',
            data: {
              messageId: currentMessageId ?? raw.toolCallId ?? '',
              role: 'assistant',
              toolCalls: [
                {
                  id: raw.toolCallId ?? '',
                  name: raw.toolName ?? '',
                  args: raw.args ?? {},
                },
              ],
            } as MessageDeltaDTO,
          };

        case 'tool_execution_update':
          // 工具执行过程中的增量输出。此前在 worker 侧被直接丢弃，客户端只能等
          // 最终结果；现在逐条透出，key 是 toolCallId。
          return {
            name: 'tool_progress',
            data: {
              messageId: currentMessageId ?? raw.toolCallId ?? '',
              toolCallId: raw.toolCallId ?? '',
              toolName: raw.toolName ?? '',
              content: extractText(raw.partialResult) || undefined,
            },
          };

        case 'tool_execution_end': {
          // pi 的 `result` 是 ToolResult 对象 `{ content, details, usage }`，
          // 不是 content 数组本身——要钻到 `.content` 才能拿到文本块。
          const text = extractText(raw.result?.content);
          return {
            name: 'tool_result',
            data: {
              messageId: currentMessageId ?? raw.toolCallId ?? '',
              role: 'assistant',
              content: text || undefined,
              toolCalls: [
                {
                  id: raw.toolCallId ?? '',
                  name: raw.toolName ?? '',
                  args: {},
                  result: text,
                  isError: Boolean(raw.isError),
                  ...(typeof raw.durationMs === 'number' ? { durationMs: raw.durationMs } : {}),
                },
              ],
            } as MessageDeltaDTO,
          };
        }

        case 'agent_end':
          // willRetry：本轮结束后 pi 是否将自动重试。此前被裁掉，客户端会把
          // 失败的一轮当成最终结果。
          return {
            name: 'agent_end',
            data: {
              messageId: 'agent',
              role: 'assistant',
              ...(typeof raw.willRetry === 'boolean' ? { willRetry: raw.willRetry } : {}),
            } as MessageDeltaDTO & { willRetry?: boolean },
          };

        case 'compaction_start':
          return {
            name: 'compaction_start',
            data: {
              ...(raw.reason ? { reason: raw.reason } : {}),
              ...(typeof raw.tokensBefore === 'number' ? { tokensBefore: raw.tokensBefore } : {}),
            },
          };

        case 'compaction_end':
          return {
            name: 'compaction_end',
            data: {
              ...(raw.reason ? { reason: raw.reason } : {}),
              ...(typeof raw.tokensBefore === 'number' ? { tokensBefore: raw.tokensBefore } : {}),
              ...(typeof raw.tokensAfter === 'number' ? { tokensAfter: raw.tokensAfter } : {}),
            },
          };

        // 分支变化（宿主合成）：客户端据此重载历史，事件本身不带消息列表。
        case 'session_branch':
          return {
            name: 'session_branch',
            data: {
              leafId: typeof raw.leafId === 'string' ? raw.leafId : null,
              oldLeafId: typeof raw.oldLeafId === 'string' ? raw.oldLeafId : null,
              reason: raw.reason === 'worker-gone' ? 'worker-gone' : 'navigate',
            },
          };

        // 平台内部事件：master 消费（同步 sessions.title），不进客户端流。
        case 'session_info_changed':
          return null;

        // 插件事件：路由与限流在入口侧，不归投影。
        case 'plugin_event':
          return null;

        // 其余 pi 事件（turn_start / turn_end / entry_appended / …）对 UI 无意义。
        default:
          return null;
      }
    },

    dispose(): void {
      currentMessageId = null;
      messageStartedAt = null;
    },
  };
}
