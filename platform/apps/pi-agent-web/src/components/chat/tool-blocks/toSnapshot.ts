/**
 * `ToolCall` → 插件看到的冻结快照。
 *
 * 只做字段映射与浅冻结：插件拿到的是普通 JSON，不是响应式对象，
 * 也就不可能反向改到会话状态。
 */

import type { ToolCallSnapshot } from '@pi-agent-platform/plugin-types/web';
import type { ToolCall } from './types';

export function toSnapshot(call: ToolCall, streaming: boolean): ToolCallSnapshot {
  const images = (call.images ?? []).map((img) => `data:${img.mimeType};base64,${img.data}`);
  return Object.freeze({
    name: call.name,
    args: call.args,
    result: call.result,
    error: call.isError ? (call.result ?? '工具执行失败') : undefined,
    images: images.length > 0 ? images : undefined,
    streaming,
    durationMs: call.durationMs,
    entryId: call.id,
  });
}
