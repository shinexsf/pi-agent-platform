/**
 * 会话文件（pi 的 JSONL）读取小工具 —— **只读**，不进 worker、不需要 pi。
 *
 * 为什么平台自己能读：`pi_session_path` 指向的是追加写 JSONL，一行一条 entry。
 * master 侧只需要"最后一条 entry 的 id"和"id → parentId 全表"这两种结构信息就能
 * 回答"当前分支是哪些 entry"——pi 的 leaf 规则在冷会话下就是"文件最后一条"，
 * 见 `doc/architecture/pi-agent-server_session-lifecycle.md` 与
 * openspec change `session-tree-and-fork`（design D1 / D5）。
 *
 * 不做的事：
 * - **不**解析成消息 DTO（那是 `routes/sessions.ts` 的 `/messages` 的职责）
 * - **不**实现 compaction 裁剪（那是模型上下文的事，pi 的 buildContextEntries 负责）
 */

import { readFileSync } from 'node:fs';

/** entry 行里我们关心的最小字段（其余原样忽略）。 */
export interface SessionFileEntryRef {
  id: string;
  parentId: string | null;
  /** 行号（0 基，含首行 header）。分页游标用它，保持与改造前一致。 */
  line: number;
}

export interface SessionFileIndex {
  /** id → { parentId, line } */
  byId: Map<string, { parentId: string | null; line: number }>;
  /** line → id（分支过滤按行号判断用，避免二次回溯） */
  idByLine: Map<number, string>;
  /** 文件最后一条 entry（pi 的 open 规则里它就是 leaf）；空文件为 null。 */
  tailId: string | null;
  /** 总行数。 */
  lineCount: number;
}

/**
 * 一次线性扫描建立索引。
 *
 * 调用方（历史端点）本来就要解析窗口内的行，这里只额外做一次 `JSON.parse` 的**轻量**
 * 版本：只取 `id` / `parentId`，坏行跳过（孤儿不影响整棵树）。
 */
export function indexSessionFile(content: string): SessionFileIndex {
  const byId = new Map<string, { parentId: string | null; line: number }>();
  const idByLine = new Map<number, string>();
  const lines = content.split('\n');
  let tailId: string | null = null;
  let lineCount = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    lineCount += 1;
    // 快路径：没有 `"id":` 的行（理论上不存在）直接跳过，避免无谓 parse。
    if (!line.includes('"id"')) continue;
    let parsed: { type?: string; id?: string; parentId?: string | null } | null = null;
    try {
      parsed = JSON.parse(line) as { type?: string; id?: string; parentId?: string | null };
    } catch {
      continue;
    }
    if (!parsed || typeof parsed.id !== 'string') continue;
    // header（type==='session'）不进树，但它占一行。
    if (parsed.type === 'session') continue;
    byId.set(parsed.id, { parentId: parsed.parentId ?? null, line: i });
    idByLine.set(i, parsed.id);
    tailId = parsed.id;
  }

  return { byId, idByLine, tailId, lineCount };
}

/** 只要"最后一条 entry 的 id"。冷会话读 leaf 用（= pi 的 `SessionManager.open()` 规则）。 */
export function readSessionFileTail(path: string): string | null {
  return indexSessionFile(readFileSync(path, 'utf8')).tailId;
}

/**
 * 从 leaf 沿 `parentId` 回溯到 root，返回 entry id 集合（**当前分支**）。
 *
 * 断链（parentId 指向不存在的 entry）就停在那里——不让一个坏 entry 让整条链路失败。
 */
export function branchEntryIds(index: SessionFileIndex, leafId: string | null): Set<string> {
  const ids = new Set<string>();
  let cur = leafId;
  while (cur) {
    const node = index.byId.get(cur);
    if (!node) break;
    ids.add(cur);
    cur = node.parentId;
  }
  return ids;
}
