/**
 * Builtin slash commands for IM gateway + HTTP command endpoint.
 *
 * 8 commands: /help /new /session /model /think /compact /name /hotkeys
 * Each returns either a string response (sent back to user via adapter.sendText)
 * or null if the command requires routing to the worker (e.g. /compact → worker).
 *
 * Precedence (per design D9): per-route custom → builtin → fallthrough to agent.
 * MVP has no per-route commands, so this is just builtin → fallthrough.
 */

import type { BuiltinCommand } from './types.js';
import type { SessionId } from '@pi-agent-platform/channel-types';
import { logger } from './logger.js';

export const BUILTIN_COMMAND_NAMES: BuiltinCommand[] = [
  'help',
  'new',
  'session',
  'model',
  'think',
  'compact',
  'name',
  'hotkeys',
];

const HELP_TEXT = `可用命令:
/help    显示此帮助
/new     创建新会话(旧会话保留)
/session 显示当前 session 信息
/model   切换模型(下一条消息生效)
/think   切换思考深度(off/low/medium/high)
/compact 压缩当前 session 历史
/name    重命名当前 session
/hotkeys 显示快捷键说明

任何其他文字将作为 prompt 发送给 agent。`;

interface BuiltinContext {
  sessionId: SessionId;
  args: string;
  /** Channel-aware helpers passed in by routing layer. */
  ctx: {
    /** Get session summary (model, thinkingLevel, etc). */
    getSessionSummary: () => Promise<{
      model: string;
      thinkingLevel: string | null;
      title: string | null;
      messageCount?: number;
    }>;
    /** Set the worker's runtime model (next prompt). */
    setModel?: (model: string) => Promise<void>;
    /** Set the worker's runtime thinking level (next prompt). */
    setThinkingLevel?: (level: 'off' | 'low' | 'medium' | 'high') => Promise<void>;
    /** Request worker to compact history. */
    compact?: () => Promise<void>;
    /** Start a brand-new session for the same chat (old session row preserved). */
    startNewSession: () => Promise<{ sessionId: SessionId }>;
    /** Rename the current session (1-200 chars). */
    setTitle?: (title: string) => Promise<void>;
  };
}

/**
 * Run a builtin command. Returns response text to send back to the user.
 * Returns null if the command is not builtin (should fall through to agent).
 */
export async function runBuiltinCommand(name: string, ctx: BuiltinContext): Promise<string | null> {
  const normalized = name.toLowerCase();
  if (!BUILTIN_COMMAND_NAMES.includes(normalized as BuiltinCommand)) {
    return null;
  }
  logger.debug({ name: normalized, sessionId: ctx.sessionId, args: ctx.args }, 'builtin command');

  // Alias: /thinking → /think (HTTP compat)
  const aliased = normalized === 'thinking' ? 'think' : normalized;

  switch (aliased) {
    case 'help':
      return HELP_TEXT;
    case 'new':
      return await handleNew(ctx);
    case 'session':
      return await handleSession(ctx);
    case 'model':
      return await handleModel(ctx);
    case 'think':
      return await handleThink(ctx);
    case 'compact':
      return await handleCompact(ctx);
    case 'name':
      return await handleName(ctx);
    case 'hotkeys':
      return HOTKEYS_TEXT;
    default:
      return null;
  }
}

async function handleNew(ctx: BuiltinContext): Promise<string> {
  try {
    const { sessionId: newSessionId } = await ctx.ctx.startNewSession();
    return `已创建新会话 ${newSessionId.slice(0, 8)}`;
  } catch (err) {
    // spawnAndCreate failure (worker capacity / workspace gone, etc). The old
    // session binding is left untouched — next message respawns it (State B).
    logger.error({ err: String(err), sessionId: ctx.sessionId }, '/new failed');
    return `创建新会话失败: ${String(err).slice(0, 200)}`;
  }
}

async function handleSession(ctx: BuiltinContext): Promise<string> {
  const s = await ctx.ctx.getSessionSummary();
  return [
    `Session: ${ctx.sessionId.slice(0, 8)}`,
    `Model: ${s.model}`,
    `Thinking: ${s.thinkingLevel ?? 'off'}`,
    s.title ? `Title: ${s.title}` : null,
    s.messageCount !== undefined ? `Messages: ${s.messageCount}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

async function handleModel(ctx: BuiltinContext): Promise<string> {
  if (!ctx.args) {
    return '用法: /model <provider/model>\n例: /model openai/gpt-4o';
  }
  if (!ctx.ctx.setModel) {
    return '当前 channel 不支持切换 model';
  }
  await ctx.ctx.setModel(ctx.args);
  return `已切到 model: ${ctx.args}`;
}

async function handleThink(ctx: BuiltinContext): Promise<string> {
  const allowed = ['off', 'low', 'medium', 'high'] as const;
  const level = ctx.args.toLowerCase();
  if (!allowed.includes(level as (typeof allowed)[number])) {
    return '用法: /think <off|low|medium|high>';
  }
  if (!ctx.ctx.setThinkingLevel) {
    return '当前 channel 不支持切换 thinking level';
  }
  await ctx.ctx.setThinkingLevel(level as (typeof allowed)[number]);
  return `已切到 thinking: ${level}`;
}

async function handleCompact(ctx: BuiltinContext): Promise<string> {
  if (!ctx.ctx.compact) {
    return '当前 channel 不支持 compact';
  }
  await ctx.ctx.compact();
  return '已请求 compact';
}

async function handleName(ctx: BuiltinContext): Promise<string> {
  const s = await ctx.ctx.getSessionSummary();
  if (!ctx.args) {
    return `当前标题: ${s.title ?? '(未命名)'}\n\n用法: /name <标题>`;
  }
  if (ctx.args.length > 200) {
    return '标题过长（最多 200 字符）';
  }
  if (!ctx.ctx.setTitle) {
    return '当前 channel 不支持重命名';
  }
  await ctx.ctx.setTitle(ctx.args);
  return `Session 已重命名为 \`${ctx.args}\``;
}

const HOTKEYS_TEXT = [
  '**键盘快捷键**',
  '- `Enter` — 发送消息',
  '- `Shift+Enter` — 换行',
  '- `/` — 打开斜杠命令菜单',
  '- `@` — 引用文件',
  '- `Esc` — 关闭菜单',
].join('\n');