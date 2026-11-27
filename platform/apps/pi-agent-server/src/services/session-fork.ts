/**
 * 会话 fork（change: session-tree-and-fork）。
 *
 * 与 pi 的 `AgentSessionRuntime.fork(entryId, { position })` 语义对齐，但有两点不同：
 *
 * 1. **fail-closed**：pi 在"第一条消息处 fork"时会转成"新建空会话 + parentSession"，
 *    我们直接 409（那是零信息量的等价物，UI 上有「新建会话」）。
 * 2. **不启 worker**：fork 出来的会话是"冷会话"（行在、文件在、worker 没有），
 *    首次 prompt 时按 `existingSessionPath` 懒恢复。
 *
 * 为什么在 server（master）而不在 worker/core：`SessionManager` 是纯文件类（`SessionManager.open()`
 * 是静态方法），而 server 本来就依赖 pi（`model-registry.ts` 用 ModelRuntime），
 * 为此再加一个 pi 依赖到 core 不划算。为了复制一个文件去 spawn 一个 agent 进程
 * 更不值得 —— 会话在列表里多半是冷的。
 *
 * 关键约束（design D3）：**成功返回的 `piSessionPath` 一定指向真实存在的文件**。
 * 悬空路径交给 worker 会被 `existsSync ? open : undefined` 静默变成"新建空会话"。
 */

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AttachmentStore, SessionRepo } from '@pi-agent-platform/core';
import type { SessionDTO } from '@pi-agent-platform/shared-types';
import { childLogger } from '@pi-agent-platform/core';

const logger = childLogger('session-fork');

export interface ForkSessionInput {
  /** 分叉点。省略 = 源会话当前 leaf（= `/clone`）。 */
  entryId?: string;
  /** `before`（默认，限 user message；"改这句重来"）/ `at`（任意 entry，含 clone）。 */
  position?: 'before' | 'at';
  /** 覆盖新会话的 model（provider/modelId）。 */
  model?: string;
  thinkingLevel?: 'off' | 'low' | 'medium' | 'high';
  title?: string;
}

export interface ForkSessionResult {
  session: SessionDTO;
  /** 实际分叉点（写进 `forked_from_entry_id`，clone 时也有值）。 */
  forkedFromEntryId: string;
  /** `before` 语义下把源消息文本带回新会话输入框。 */
  selectedText?: string;
}

export interface ForkSessionDeps {
  sessionRepo: SessionRepo;
  /** 只需读：校验 agent 存在（`createFromAgent` 内部自己查 agent 行）。 */
  agentRepo: { get(id: string): { id: string } | undefined };
  attachmentStore: AttachmentStore;
  /** 取源会话当前 leaf（worker 活着问 pi，否则文件最后一条）。 */
  resolveLeafId: (sessionId: string) => Promise<string | null>;
}

/** 业务错误：带 `code` + 建议的 HTTP 状态，路由层原样映射。 */
export class ForkError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: 400 | 404 | 409 | 500,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ForkError';
  }
}

interface RawEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  message?: { role?: string; content?: unknown };
  content?: unknown;
}

/** 从 user message 的 content 里摘文本（`before` 语义要把这句放回输入框）。 */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => String((b as { text?: unknown }).text ?? ''))
    .join('');
}

/**
 * 抽一条路径成新会话文件。
 *
 * 用**另开**的 SessionManager（`SessionManager.open(源文件)`）：`createBranchedSession()`
 * 会改写接收者自身的 `sessionId` / `sessionFile`，绝不能在"活着的那个 manager"上调。
 */
export async function forkSession(deps: ForkSessionDeps, sessionId: string, input: ForkSessionInput = {}): Promise<ForkSessionResult> {
  const source = deps.sessionRepo.get(sessionId);
  if (!source) throw new ForkError('Session not found', 'session_not_found', 404);
  const agent = deps.agentRepo.get(source.agentId);
  if (!agent) throw new ForkError('Agent not found for this session', 'agent_not_found', 404);

  const position = input.position ?? 'before';
  // 5) 源文件必须先落盘（没有 user/assistant 消息时 pi 根本不写文件）
  if (!existsSync(source.piSessionPath)) {
    throw new ForkError('Session has not been persisted yet — send a message before forking', 'source_not_persisted', 409);
  }

  const manager = SessionManager.open(source.piSessionPath);
  const entries = manager.getEntries() as unknown as RawEntry[];

  // 1) 目标 entry
  let targetLeafId: string | null;
  let selectedText: string | undefined;
  if (input.entryId) {
    const entry = entries.find((e) => e.id === input.entryId);
    if (!entry) throw new ForkError(`Entry not found: ${input.entryId}`, 'entry_not_found', 404);
    if (position === 'at') {
      targetLeafId = entry.id ?? null;
    } else {
      // 2) before 语义只允许 user message（照 pi 的校验）
      if (entry.type !== 'message' || entry.message?.role !== 'user') {
        throw new ForkError('position=before requires a user message', 'invalid_entry_for_position', 400);
      }
      targetLeafId = entry.parentId ?? null;
      selectedText = textOfContent(entry.message?.content);
    }
  } else {
    // 省略 entryId = clone 当前 leaf
    targetLeafId = (await deps.resolveLeafId(sessionId)) ?? null;
    if (!targetLeafId) {
      throw new ForkError('Session is empty — nothing to clone', 'empty_session', 409);
    }
  }

  // 4) 第一条消息处 fork = 新建会话（零信息量）
  if (!targetLeafId) {
    throw new ForkError('Forking before the first message equals a new session — use "new session" instead', 'fork_before_first_message', 409);
  }

  // 5b) 路径上必须已经有对话内容 —— pi 的落盘是 lazy 的：`createBranchedSession()`
  // 只在"路径上有 user/assistant 消息"时才真的写文件（`_hasConversation()`），
  // 否则返回一个不存在的路径。这里提前用同一个判据预测，给出 409 而不是事后 500。
  // 典型触发：在**第一轮对话之前**分叉（那等于新建会话）。
  const branchPath = manager.getBranch(targetLeafId) as unknown as RawEntry[];
  const hasConversation = branchPath.some(
    (e) => e.type === 'message' && (e.message?.role === 'user' || e.message?.role === 'assistant'),
  );
  if (!hasConversation) {
    throw new ForkError(
      'Nothing to fork: there is no conversation before this point (equivalent to a new session)',
      'fork_has_no_conversation',
      409,
    );
  }

  // 6) 抽文件（pi 会重链 label、重映射 compaction.firstKeptEntryId、写 parentSession 头）
  let newPath: string | undefined;
  try {
    newPath = manager.createBranchedSession(targetLeafId);
  } catch (err) {
    throw new ForkError(`Failed to create forked session: ${(err as Error).message}`, 'fork_failed', 500);
  }

  // 7) 产物必须存在（position=at + 无消息祖先的 entry 会返回不存在的路径）
  if (!newPath || !existsSync(newPath)) {
    logger.error({ sessionId, targetLeafId, newPath }, 'createBranchedSession returned a path with no file on disk');
    throw new ForkError('Fork produced no file on disk', 'fork_produced_no_file', 500);
  }

  const newSessionId = randomUUID();
  const title = input.title ?? (source.title ? `${source.title} · 分叉` : undefined);
  const created = deps.sessionRepo.createFromAgent({
    sessionId: newSessionId,
    agentId: source.agentId,
    piSessionPath: newPath,
    ...(title ? { title } : {}),
    // model / thinkingLevel / config 取**源会话行快照**（可被入参覆盖），
    // 不从 agent 复制 —— 分叉出来的会话不该因 agent 后来改配置而变样。
    snapshot: {
      model: input.model ?? source.model,
      thinkingLevel: input.thinkingLevel ?? source.thinkingLevel ?? null,
      config: source.config,
    },
    lineage: { parentSessionId: sessionId, forkedFromEntryId: targetLeafId },
  });
  if (!created) throw new ForkError('Failed to persist forked session row', 'persist_failed', 500);

  // 附件：行复制 + hardlink（失败退化 copy；单个文件失败只 warn，不阻塞分叉）
  try {
    const cloned = await deps.attachmentStore.cloneBySession(sessionId, newSessionId);
    if (cloned.rowsCopied > 0) {
      logger.info({ from: sessionId, to: newSessionId, ...cloned }, 'attachments cloned');
    }
  } catch (err) {
    logger.warn({ err, from: sessionId, to: newSessionId }, 'attachment clone failed; forked session keeps its rows only');
  }

  logger.info(
    { from: sessionId, to: newSessionId, entryId: input.entryId ?? '(leaf)', position, targetLeafId, path: newPath },
    'session forked (no worker spawned)',
  );

  return {
    session: created,
    forkedFromEntryId: targetLeafId,
    ...(selectedText !== undefined ? { selectedText } : {}),
  };
}
