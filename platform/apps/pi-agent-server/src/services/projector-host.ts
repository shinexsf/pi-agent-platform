/**
 * 会话级投影器宿主（入口层）。
 *
 * 投影包本身不依赖内核，内核也不知道 UI 长什么样 —— 所以"哪个会话用哪个投影器"
 * 这件记账放在入口层。
 *
 * 生命周期（spec `event-projection-package`）：
 * - 该会话出现**第一个**订阅者时惰性创建
 * - 最后一个订阅者退出时释放（引用计数归零）
 * - 同一会话的多个订阅者共享同一实例 —— 各建一份会让累积状态各自漂移
 *
 * 注：不同入口进程（未来的桌面端）各有自己的实例，这是可接受的：投影器不持有
 * "对话内容"的权威状态（它从每一条原生事件的完整快照里取值），只有 message 序号，
 * 而序号由 `message_start` 的出现次数决定，两侧必然一致。
 */

import { createSessionProjector, type SessionProjector } from '@pi-agent-platform/event-projection';

interface Entry {
  projector: SessionProjector;
  refs: number;
}

const store = new Map<string, Entry>();

/**
 * 取用某会话的投影器并 +1 引用。调用方必须在不再需要时 `releaseProjector`。
 */
export function acquireProjector(sessionId: string): SessionProjector {
  let entry = store.get(sessionId);
  if (!entry) {
    entry = { projector: createSessionProjector(), refs: 0 };
    store.set(sessionId, entry);
  }
  entry.refs += 1;
  return entry.projector;
}

/** -1 引用；归零时丢弃实例。 */
export function releaseProjector(sessionId: string): void {
  const entry = store.get(sessionId);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entry.projector.dispose();
  store.delete(sessionId);
}

/** 诊断用：当前存活的投影器数量（不应随订阅者数量无限增长）。 */
export function projectorCount(): number {
  return store.size;
}
