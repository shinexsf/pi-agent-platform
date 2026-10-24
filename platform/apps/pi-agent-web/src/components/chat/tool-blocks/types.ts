/**
 * Tool block contract (change: session-streaming-runtime, group 6).
 *
 * A tool block is a self-contained renderer for one `ToolCallDTO` (call + merged
 * result). The registry picks the block **by tool name**: `read` → ReadCard,
 * `bash` → BashCard, … and anything without a dedicated card falls back to
 * `DefaultCard`, so unknown tools always render.
 *
 * There is deliberately no "kind" category: only first-party tools have a
 * knowable category, and a third-party tool (or a future user script) is matched
 * by its name alone.
 */

import type { Component } from 'vue'
import type { MessageDTO } from '@pi-agent-platform/shared-types'

/** One tool call as carried on an assistant message (`call` + merged `result`). */
export type ToolCall = NonNullable<MessageDTO['toolCalls']>[number]

/** What MessageItem hands to a block. */
export interface ToolBlockProps {
  /** The tool call, including the merged `result` / `isError` / `images`. */
  call: ToolCall
  /** While the message is still streaming the block force-expands its body. */
  streaming: boolean
  /** Display name — the raw tool name. */
  label?: string
}

/** A block resolves to a component plus display metadata. */
export interface ToolBlockBinding {
  component: Component
  label?: string
}
