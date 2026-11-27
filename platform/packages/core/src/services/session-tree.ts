/**
 * 会话树的服务层实现（change: session-tree-and-fork）。
 *
 * HTTP 路由（`routes/sessions.ts`）与插件宿主面（`host.sessions.tree/navigate`）
 * **共用这一份**：树/导航都跨 worker（pi 侧）与 DTO 裁剪两处，两处各写一遍必然漂移。
 *
 * 设计要点（见 openspec change 的 design D1 / D2）：
 * - leaf 只有一个来源：worker 存活问 pi（`__core__.getLeafId` / navigate 返回值），
 *   否则取文件最后一条 entry。平台**不缓存、不落库**。
 * - 导航必须走 `AgentSession.navigateTree()`（worker 内），它会刷新模型上下文与工具集。
 * - 导航成功后由 `Session.navigateTree()` 广播 `session_branch`（pi 的 `session_tree`
 *   只发给扩展，订阅者收不到）。
 */

import type { SessionTreeNodeDTO, SessionTreeResponse } from '@pi-agent-platform/api-types';
import type { WorkerPool } from '../worker-pool.js';
import type { SessionRepo } from '../repos/session.repo.js';
import type { SessionRegistry } from './session.js';

/** worker 侧透传的原始树节点（pi `sessionManager.getTree()`）。 */
interface RawTreeNode {
  entry: { id: string; parentId: string | null; type: string; timestamp?: string } & Record<string, unknown>;
  children: RawTreeNode[];
  label?: string;
}

const PREVIEW_MAX = 96;

/** 从 entry 里摘一行预览 —— 只读我们认识的形状，不认识的类型给个类型名。 */
function previewOf(entry: RawTreeNode['entry']): string {
  const raw = entry as Record<string, unknown>;
  if (entry.type === 'message') {
    const msg = raw.message as { role?: string; content?: unknown } | undefined;
    const content = msg?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
        .map((b) => String((b as { text?: unknown }).text ?? ''))
        .join('');
    }
    if (!text) {
      const role = msg?.role ?? 'message';
      return role === 'toolResult' ? `[toolResult] ${String(raw.toolName ?? '')}`.trim() : `[${role}]`;
    }
    return text.replace(/\s+/g, ' ').slice(0, PREVIEW_MAX);
  }
  if (entry.type === 'custom_message') {
    const content = raw.content;
    const text = typeof content === 'string' ? content : '';
    return text ? text.replace(/\s+/g, ' ').slice(0, PREVIEW_MAX) : '[custom_message]';
  }
  if (entry.type === 'compaction') return '[压缩检查点]';
  if (entry.type === 'model_change') return `[model] ${String(raw.provider ?? '')}/${String(raw.modelId ?? '')}`;
  if (entry.type === 'thinking_level_change') return `[thinking] ${String(raw.thinkingLevel ?? '')}`;
  if (entry.type === 'branch_summary') return '[分支摘要]';
  if (entry.type === 'session_info') return `[会话名] ${String(raw.name ?? '')}`;
  if (entry.type === 'label') return `[label] ${String(raw.label ?? '')}`;
  if (entry.type === 'context_edit') return '[上下文改写]';
  if (entry.type === 'usage') return `[usage] ${String(raw.kind ?? '')}`;
  return `[${entry.type}]`;
}

function roleOf(entry: RawTreeNode['entry']): string | undefined {
  if (entry.type !== 'message') return undefined;
  const msg = (entry as { message?: { role?: unknown } }).message;
  return typeof msg?.role === 'string' ? msg.role : undefined;
}

/** raw 树 → 客户端 DTO（同一份给 HTTP 与插件面）。 */
export function toTreeNodeDTO(node: RawTreeNode, leafId: string | null): SessionTreeNodeDTO {
  const entry = node.entry;
  return {
    id: entry.id,
    parentId: entry.parentId,
    type: entry.type,
    ...(roleOf(entry) ? { role: roleOf(entry) } : {}),
    preview: previewOf(entry),
    ...(node.label ? { label: node.label } : {}),
    ...(entry.timestamp ? { timestamp: entry.timestamp } : {}),
    childCount: node.children.length,
    isLeaf: entry.id === leafId,
    // pi 会按时间正序给 children（getTree 内已排序），这里保持顺序。
    children: node.children.map((child) => toTreeNodeDTO(child, leafId)),
  };
}

export interface SessionTreeDeps {
  workerPool: WorkerPool;
  sessionRepo: SessionRepo;
  sessionRegistry: SessionRegistry;
}

/** 会话行必须存在；worker 不在时抛 `worker_not_running`（树只有 pi 内存里那份是权威的）。 */
function requireLiveSession(deps: SessionTreeDeps, sessionId: string) {
  const row = deps.sessionRepo.get(sessionId);
  if (!row) {
    throw Object.assign(new Error('Session not found'), { code: 'session_not_found' });
  }
  const session = deps.sessionRegistry.get(sessionId);
  if (!session || !session.alive) {
    throw Object.assign(new Error('session worker is not running'), { code: 'worker_not_running' });
  }
  return session;
}

/**
 * 读会话树。
 *
 * 要求 worker 存活：pi 的 leaf 只在进程内存里，读文件只能拿到"最后一条 entry"，
 * 那会在"导航后未落盘"的情况下给出错误的分支。冷会话由调用方先恢复（HTTP 层做懒恢复）。
 */
export async function readSessionTree(deps: SessionTreeDeps, sessionId: string): Promise<SessionTreeResponse> {
  const session = requireLiveSession(deps, sessionId);
  const { leafId, tree } = await session.getTree();
  const rawTree = tree as RawTreeNode[];
  return {
    sessionId,
    leafId,
    tree: rawTree.map((node) => toTreeNodeDTO(node, leafId)),
  };
}

/**
 * 在当前会话文件内移动 leaf。
 *
 * `expectedLeafId`：乐观并发校验（多窗口"最后导航赢"会让另一个窗口静默错位）。
 */
export async function navigateSessionTree(
  deps: SessionTreeDeps,
  sessionId: string,
  entryId: string,
  opts?: { expectedLeafId?: string },
): Promise<{ leafId: string | null; editorText?: string }> {
  const session = requireLiveSession(deps, sessionId);
  if (opts?.expectedLeafId !== undefined) {
    const current = await session.leafId();
    if (current !== opts.expectedLeafId) {
      throw Object.assign(new Error('branch moved (expectedLeafId mismatch)'), {
        code: 'leaf_mismatch',
        currentLeafId: current,
      });
    }
  }
  const tree = await session.getTree();
  const known = new Set<string>();
  const collect = (nodes: RawTreeNode[]) => {
    for (const n of nodes) {
      known.add(n.entry.id);
      collect(n.children);
    }
  };
  collect(tree.tree as RawTreeNode[]);
  if (!known.has(entryId)) {
    throw Object.assign(new Error(`entry not found: ${entryId}`), { code: 'entry_not_found' });
  }
  return session.navigateTree(entryId);
}
