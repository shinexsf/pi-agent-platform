/**
 * SSE + bridge control composable.
 *
 * Responsibilities:
 *   - Subscribe to /api/sessions/:id/events (SSE stream)
 *   - Apply MessageDeltaDTO → Vue reactive messages[]
 *   - Send prompt + abort + steer/followUp
 *   - Subscribe to bridge 'session.queue_update' event (steer mode queue)
 *   - Unified context (commands + models + session) via registerContextHandler
 *   - Track error context for inline error item rendering
 *
 * Context model (session-lifecycle-v2):
 *   - contextCache holds the full SessionContextDTO from GET /:id/context
 *   - Components declare which fields they consume via registerContextHandler(key, handler)
 *   - loadContext() fetches and dispatches to all handlers
 *   - This replaces the old per-field cache ref pattern (commandsCache/modelsCache/etc.)
 */

import { ref, computed } from 'vue'
import type { MessageDTO, MessageDeltaDTO } from '@pi-agent-platform/shared-types'
import type { SessionContextDTO, SlashCommandDTO, ModelInfo } from '@pi-agent-platform/api-types'
import { useIdeBridge, onIdeBridgeReady } from './useIdeBridge'

export interface UseSSEOptions {
  sessionId: string
}

// Re-export shared types so existing component imports keep working
export type SlashCommand = SlashCommandDTO
export type { ModelInfo, SessionContextDTO }

/** Field of SessionContextDTO that a handler wants to subscribe to. */
export type ContextField = keyof SessionContextDTO

type ContextHandler<K extends ContextField> = (
  value: SessionContextDTO[K],
  ctx: SessionContextDTO,
) => void

export interface ErrorContext {
  /** Where the error came from: 'send' | 'sse_connection' | 'sse_event' */
  source: 'send' | 'sse_connection' | 'sse_event'
  /** Optional related user message id (for retry) */
  relatedUserMessageId?: string
  /** Original user message text (for retry) */
  relatedUserMessageText?: string
  message: string
}

// ── Module-level singletons (shared across all useSSE() instances) ──
// Required because multiple components (InputBox / SlashCommandMenu / ModelSelector /
// ThinkingSelector) need to subscribe to the same context independently. Each
// useSSE() call returns a thin wrapper around these shared refs.
const contextCache = ref<SessionContextDTO | null>(null)
const contextHandlers = new Map<ContextField, (value: any, ctx: SessionContextDTO) => void>()

function dispatchContext(ctx: SessionContextDTO) {
  for (const [key, handler] of contextHandlers) {
    handler(ctx[key], ctx)
  }
}

export function useSSE(options: UseSSEOptions) {
  const bridge = useIdeBridge()
  const connected = ref(false)
  const messages = ref<MessageDTO[]>([])
  const sending = ref(false)
  const error = ref<ErrorContext | null>(null)

  // ── Steer mode (per D8 / C2: only 'steer'; no follow-up) ──
  const steeringQueue = ref<string[]>([])
  const streamingBehavior = ref<'steer'>('steer')

  /**
   * Subscribe to a specific context field. The handler is invoked immediately
   * if contextCache already has a value, and on every loadContext() refresh.
   * Returns an unsubscribe function — call it on component unmount.
   */
  function registerContextHandler<K extends ContextField>(
    key: K,
    handler: ContextHandler<K>,
  ): () => void {
    contextHandlers.set(key, handler as (v: any, ctx: SessionContextDTO) => void)
    if (contextCache.value) {
      handler(contextCache.value[key], contextCache.value)
    }
    return () => {
      if (contextHandlers.get(key) === handler) {
        contextHandlers.delete(key)
      }
    }
  }

  function dispatchContext(ctx: SessionContextDTO) {
    for (const [key, handler] of contextHandlers) {
      handler(ctx[key], ctx)
    }
  }

  let eventSource: EventSource | null = null

  // ── Message delta handling ──

  function applyDelta(delta: MessageDeltaDTO) {
    if (delta.role === 'toolResult' && delta.toolCallId) {
      mergeToolResultToAssistant(delta)
      return
    }
    const existing = messages.value.find((m) => m.id === delta.messageId)
    if (existing) {
      if (delta.content !== undefined) existing.content = delta.content
      if (delta.thinking !== undefined) existing.thinking = delta.thinking
      if (delta.toolCalls !== undefined) existing.toolCalls = delta.toolCalls
      if (delta.model) existing.model = delta.model
      if (delta.provider) existing.provider = delta.provider
      if (delta.stopReason) existing.stopReason = delta.stopReason
      if (delta.toolCallId) existing.toolCallId = delta.toolCallId
      if (delta.toolName) existing.toolName = delta.toolName
    } else {
      const msg: MessageDTO = {
        id: delta.messageId,
        parentId: delta.parentId,
        role: delta.role,
        content: delta.content ?? '',
        thinking: delta.thinking,
        toolCalls: delta.toolCalls,
        toolCallId: delta.toolCallId,
        toolName: delta.toolName,
        model: delta.model,
        provider: delta.provider,
        stopReason: delta.stopReason,
        timestamp: Date.now(),
      }
      messages.value.push(msg)
    }
  }

  function mergeToolResultToAssistant(delta: MessageDeltaDTO) {
    if (!delta.toolCallId) return
    for (const msg of messages.value) {
      if (msg.toolCalls) {
        const tc = msg.toolCalls.find((t) => t.id === delta.toolCallId)
        if (tc) {
          tc.result = delta.content ?? tc.result
          // pi SDK's ToolResultMessage has `isError: boolean` as a top-level
          // field on the message. Worker forwards it on the MessageDeltaDTO
          // (not via stopReason, which is assistant-only). Fall back to the
          // delta's toolCalls[0].isError for the older tool_result SSE path
          // — that event carries the same flag inside the toolCalls array.
          if (typeof delta.isError === 'boolean') {
            tc.isError = delta.isError
          } else if (delta.toolCalls?.[0] && typeof delta.toolCalls[0].isError === 'boolean') {
            tc.isError = delta.toolCalls[0].isError
          }
          return
        }
      }
    }
  }

  // ── Streaming state markers ──
  // Per-message `__isStreaming` flag (NOT in MessageDTO type) drives the
  // "collapsed preview when done, expanded while streaming" behavior in
  // MessageItem for thinking + toolResult. History reload doesn't set this
  // field → defaults to undefined/false → old messages stay collapsed (good).
  function markMessageStreaming(messageId: string) {
    const m = messages.value.find((x) => x.id === messageId)
    if (m) (m as any).__isStreaming = true
  }
  function markMessageEnded(messageId: string) {
    const m = messages.value.find((x) => x.id === messageId)
    if (m) (m as any).__isStreaming = false
  }

  // ── Error handling ──

  function insertError(ctx: ErrorContext) {
    const errMsg: MessageDTO = {
      id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'error' as any, // MessageRole doesn't include 'error' yet — handled in MessageItem
      content: ctx.message,
      timestamp: Date.now(),
    }
    ;(errMsg as any).__errorContext = ctx
    messages.value.push(errMsg)
    error.value = ctx
  }

  function clearError(messageId: string) {
    messages.value = messages.value.filter((m) => m.id !== messageId)
    error.value = null
  }

  function clearConnectionError() {
    if (error.value?.source === 'sse_connection') {
      clearError(messages.value.find((m) => m.role === ('error' as any))?.id ?? '')
    }
  }

  /** Insert an assistant-style message for slash command output (e.g. /session, /hotkeys). */
  function insertAssistant(content: string) {
    const msg: MessageDTO = {
      id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant',
      content,
      timestamp: Date.now(),
    }
    messages.value.push(msg)
  }

  // ── SSE subscription ──

  function subscribe() {
    if (eventSource) return
    eventSource = new EventSource(`/api/sessions/${options.sessionId}/events`)

    eventSource.addEventListener('connected', () => {
      connected.value = true
      clearConnectionError()
    })

    eventSource.addEventListener('message_update', (e) => {
      try {
        const delta: MessageDeltaDTO = JSON.parse((e as MessageEvent).data)
        applyDelta(delta)
        markMessageStreaming(delta.messageId)
      } catch (err) {
        console.error('[SSE] failed to parse message_update:', err)
      }
    })

    eventSource.addEventListener('message_end', (e) => {
      try {
        const delta: MessageDeltaDTO = JSON.parse((e as MessageEvent).data)
        applyDelta(delta)
        // Mark ended AFTER applyDelta so the final stopReason/thinking/etc.
        // are committed before the UI collapses the preview.
        markMessageEnded(delta.messageId)
      } catch (err) {
        console.error('[SSE] failed to parse message_end:', err)
      }
    })

    eventSource.addEventListener('agent_end', () => {
      sending.value = false
      // Refresh context so the InputBox's context-usage ring shows the new
      // window occupancy for this turn. Each turn is a natural refresh
      // boundary — between turns the value is stale but not used for
      // user-visible decisions; after each turn we re-sync from server.
      void loadContext()
    })

    eventSource.addEventListener('queue_update', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as { steering?: string[]; followUp?: string[] }
        steeringQueue.value = data.steering ?? []
      } catch (err) {
        console.error('[SSE] failed to parse queue_update:', err)
      }
    })

    eventSource.addEventListener('error', (e) => {
      console.error('[SSE] connection error:', e)
      connected.value = false
      insertError({ source: 'sse_connection', message: 'Connection lost, retrying…' })
    })

    eventSource.addEventListener('message_error', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data)
        insertError({ source: 'sse_event', message: data.message ?? 'Unknown error' })
      } catch {
        insertError({ source: 'sse_event', message: 'Unknown error' })
      }
      sending.value = false
    })
  }

  function unsubscribe() {
    if (eventSource) {
      eventSource.close()
      eventSource = null
      connected.value = false
    }
  }

  async function loadHistory() {
    try {
      const res = await fetch(`/api/sessions/${options.sessionId}/messages`)
      if (!res.ok) return
      const data = (await res.json()) as { messages: MessageDTO[] }
      // Merge standalone toolResult messages into their parent assistant's
      // matching toolCall, then drop the toolResult entries. Mirrors
      // mergeToolResultToAssistant used in the streaming path.
      // Why: MessageItem renders call + result as ONE card (collapsed
      // preview when done, click to expand). Without the merge, the
      // toolCall card shows '[running]' (tc.result undefined) and the
      // standalone toolResult message renders as an empty assistant row.
      // Webui displays toolResult as its own card and consumes the raw
      // stream, so server keeps the original entries.
      messages.value = mergeToolResultsIntoCalls(data.messages)
    } catch (err) {
      console.warn('[SSE] loadHistory failed:', err)
    }
  }

  /**
   * Attach toolResult content + isError onto the matching toolCall, then
   * remove the toolResult entries.
   *
   * isError source: `m.isError` on the toolResult MessageDTO. This is the
   * server-parsed value of pi SDK's `ToolResultMessage.isError` (top-level
   * field on the message). Earlier this read `m.stopReason === 'error'`,
   * but `stopReason` is an assistant-only field — it was always undefined
   * for toolResult messages, so isError was always false in history view.
   */
  function mergeToolResultsIntoCalls(msgs: MessageDTO[]): MessageDTO[] {
    const toolResults = new Map<string, {
      result: string
      isError: boolean
      images: MessageDTO['images']
    }>()
    for (const m of msgs) {
      if (m.role === 'toolResult' && m.toolCallId) {
        toolResults.set(m.toolCallId, {
          result: m.content ?? '',
          isError: m.isError === true,
          images: m.images,
        })
      }
    }
    const out: MessageDTO[] = []
    for (const m of msgs) {
      if (m.role === 'toolResult') continue
      if (m.role === 'assistant' && m.toolCalls) {
        for (const tc of m.toolCalls) {
          const r = toolResults.get(tc.id)
          if (r) {
            tc.result = r.result
            tc.isError = r.isError
            if (r.images) tc.images = r.images
          }
        }
      }
      out.push(m)
    }
    return out
  }

  /**
   * Fetch unified context (commands + models + session metadata).
   * Writes contextCache and dispatches to all registered handlers.
   * Call this on app mount, and after any mutation that may change context
   * (send / setModel / setThinkingLevel).
   */
  async function loadContext(): Promise<void> {
    try {
      const res = await fetch(`/api/sessions/${options.sessionId}/context`)
      if (!res.ok) throw new Error(`context ${res.status}`)
      const data = (await res.json()) as SessionContextDTO
      contextCache.value = data
      dispatchContext(data)
    } catch (err) {
      console.warn('[SSE] loadContext failed:', err)
      insertError({ source: 'sse_connection', message: `Load context failed: ${err}` })
    }
  }

  /**
   * Placeholder fallback: previously fetched agent defaults to populate
   * currentModel/currentThinkingLevel before the first prompt. In the new
   * context-driven model, `context.session` is null for placeholder sessions
   * and components handle null themselves. Kept for API compatibility but
   * does nothing — the real values come from `loadContext()`.
   */
  async function loadAgentDefaults(_agentId: string) {
    // no-op: context.session is null for placeholder; selectors show fallback text.
  }

  // ── Prompt / abort / steer ──

  /**
   * Send a user message. Optional `attachedImages` is filled from
   * `useAttachments.cache` so the user bubble renders thumbnails in chat area
   * (Option A — cache 直传; see design.md Goals §F3 实现选型).
   * Server's `/prompt` endpoint extracts `[pi-attachment:att_xxx]` markers and
   * looks them up server-side; no need to send the bytes back.
   */
  async function send(
    agentId: string,
    message: string,
    attachedImages?: Array<{ mimeType: string; data: string }>,
  ) {
    if (sending.value) return
    sending.value = true

    const tempUserId = `temp-user-${Date.now()}`
    const userMsg: MessageDTO = {
      id: tempUserId,
      role: 'user',
      content: message,
      timestamp: Date.now(),
      // Same shape as history-route responses (MessageDTO.images?),
      // so <MessageItem> uses one render branch for both live and history.
      images: attachedImages && attachedImages.length > 0 ? attachedImages : undefined,
    }
    messages.value.push(userMsg)

    try {
      const body: Record<string, unknown> = { agentId, message, streamingBehavior: 'steer' }
      const res = await fetch(`/api/sessions/${options.sessionId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const errMsg = `Send failed (${res.status})`
        insertError({
          source: 'send',
          relatedUserMessageId: tempUserId,
          relatedUserMessageText: message,
          message: errMsg,
        })
        messages.value = messages.value.filter((m) => m.id !== tempUserId)
        sending.value = false
      }
      // No loadContext() — currentModel / currentThinkingLevel / commands are already populated
      // by the placeholder worker at tab-open. hasRow flips from false→true server-side,
      // but the client doesn't consume that field for selector rendering.
    } catch (err) {
      insertError({
        source: 'send',
        relatedUserMessageId: tempUserId,
        relatedUserMessageText: message,
        message: String(err),
      })
      messages.value = messages.value.filter((m) => m.id !== tempUserId)
      sending.value = false
    }
  }

  async function abort() {
    try {
      await fetch(`/api/sessions/${options.sessionId}/abort`, { method: 'POST' })
      sending.value = false
    } catch (err) {
      console.error('[SSE] abort failed:', err)
    }
  }

  async function retry(userMessageText: string, agentId: string) {
    messages.value = messages.value.filter((m) => m.role !== ('error' as any))
    error.value = null
    await send(agentId, userMessageText)
  }

  // ── Slash commands (per C3) ──

  async function dispatchCommand(name: string, args: string) {
    // Echo the slash command as a user bubble so it shows up in the chat area.
    // Without this, the command's response (when any) appears immediately under
    // the previous agent reply with no visible separator — they look fused.
    // Echo is client-only (never sent to the model), so server history replay
    // won't include it. Acceptable trade-off for now; revisit if reload hygiene
    // becomes a complaint.
    const echoId = `cmd-echo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    messages.value.push({
      id: echoId,
      role: 'user',
      content: args ? `/${name} ${args}` : `/${name}`,
      timestamp: Date.now(),
    })

    try {
      const res = await fetch(`/api/sessions/${options.sessionId}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, args }),
      })
      const data = (await res.json().catch(() => null)) as { error?: string; result?: { kind: string; content?: string } | null } | null
      if (!res.ok) {
        const msg = data?.error ?? `HTTP ${res.status}`
        insertError({ source: 'sse_event', message: `Command /${name} failed: ${msg}` })
        return
      }
      const result = data?.result
      if (result && result.kind === 'text' && result.content) {
        insertAssistant(result.content)
      }
    } catch (err) {
      insertError({ source: 'sse_event', message: `Command /${name} error: ${err}` })
    }
  }

  // ── Model / Thinking mutation (per C4 / C5) ──
  // After mutation, reload context to update the cached session field —
  // handlers subscribed via registerContextHandler('session', ...) get fresh values.

  async function setModel(provider: string, modelId: string) {
    try {
      const res = await fetch(`/api/sessions/${options.sessionId}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, modelId }),
      })
      if (res.ok) {
        await loadContext()
      } else {
        insertError({ source: 'sse_event', message: `Set model failed: ${res.status}` })
      }
    } catch (err) {
      insertError({ source: 'sse_event', message: `Set model error: ${err}` })
    }
  }

  async function setThinkingLevel(level: 'off' | 'low' | 'medium' | 'high') {
    try {
      const res = await fetch(`/api/sessions/${options.sessionId}/think`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level }),
      })
      if (res.ok) {
        // Refresh context to pick up the server-authoritative currentThinkingLevel
        // (matches setModel's pattern). thinkingLevel is session-only (NOT persisted
        // to DB per OQ-D2), so we can't derive it from session.thinkingLevel alone.
        await loadContext()
      } else {
        insertError({ source: 'sse_event', message: `Set thinking failed: ${res.status}` })
      }
    } catch (err) {
      insertError({ source: 'sse_event', message: `Set thinking error: ${err}` })
    }
  }

  // ── Subscribe to steer queue events from bridge (Kotlin-side SSE → bridge.on) ──

  function subscribeToSteerQueue() {
    onIdeBridgeReady((b) => {
      b.on('session.queue_update', (data: unknown) => {
        const d = data as { steering?: string[]; followUp?: string[] }
        steeringQueue.value = d.steering ?? []
      })
    })
  }

  const lastMessage = computed(() => messages.value[messages.value.length - 1])

  return {
    // state
    connected,
    sending,
    error,
    messages,
    lastMessage,
    steeringQueue,
    streamingBehavior,
    contextCache,
    // methods
    subscribe,
    unsubscribe,
    loadHistory,
    loadContext,
    loadAgentDefaults,
    registerContextHandler,
    send,
    abort,
    retry,
    dispatchCommand,
    setModel,
    setThinkingLevel,
    insertError,
    clearError,
    subscribeToSteerQueue,
  }
}