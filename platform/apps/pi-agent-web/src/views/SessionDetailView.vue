<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import type { AgentDTO, MessageDTO, ToolCallDTO } from '@pi-agent-platform/shared-types';
import { useTheme } from '../composables/useTheme';
import { useSSE } from '../composables/useSSE';

const props = defineProps<{ id: string }>();
const route = useRoute();

const messages = ref<MessageDTO[]>([]);
const input = ref('');
const connected = ref(false);
const sending = ref(false);

const agent = ref<AgentDTO | null>(null);

// ---------- Auto-scroll ----------
const messagesEl = ref<HTMLElement | null>(null);
const autoScroll = ref(true); // true = stick to bottom

function onMessagesScroll() {
  const el = messagesEl.value;
  if (!el) return;
  const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
  // Threshold 50px: if user is near the bottom, treat as "at bottom".
  autoScroll.value = distanceFromBottom < 50;
}

function scrollToBottom(smooth = true) {
  const el = messagesEl.value;
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  autoScroll.value = true;
}

// Watch both list length (new message) and last message content (streaming update).
watch(
  () => {
    const last = messages.value[messages.value.length - 1];
    return [messages.value.length, last?.content ?? '', last?.thinking ?? ''];
  },
  () => {
    if (!autoScroll.value) return;
    nextTick(() => scrollToBottom(true));
  },
  { flush: 'post' },
);

/** agentId comes from URL query (set when user clicked "New session" in agents list).
 *  Falls back to session row for pre-existing sessions (e.g. after refresh). */
const agentIdFromQuery = computed<string | null>(() => {
  const v = route.query.agentId;
  return typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null;
});

const { theme } = useTheme();

/** Load agent details. Required for placeholder sessions (which have no DB row). */
async function loadAgent(): Promise<string | null> {
  let id = agentIdFromQuery.value;

  // For pre-existing sessions (not placeholder), agentId can come from session row.
  if (!id) {
    const sess = await fetch(`/api/sessions/${props.id}`).then((r) => (r.ok ? r.json() : null));
    if (sess?.agentId) id = sess.agentId as string;
  }

  if (!id) return null;

  agent.value = await fetch(`/api/agents/${id}`).then((r) => (r.ok ? r.json() : null));
  return id;
}

async function loadHistory(): Promise<void> {
  try {
    const res = await fetch(`/api/sessions/${props.id}/messages`);
    if (!res.ok) return;
    const data = (await res.json()) as { messages: MessageDTO[] };
    messages.value = data.messages;
  } catch {
    // ignore — empty history is fine
  }
}

/** Apply a delta from SSE to the message list. */
function applyDelta(delta: {
  messageId: string;
  parentId?: string;
  role: MessageDTO['role'];
  content?: string;
  thinking?: string;
  toolCalls?: ToolCallDTO[];
  toolCallId?: string;
  toolName?: string;
  model?: string;
  provider?: string;
  stopReason?: string;
}) {
  const existing = messages.value.find((m) => m.id === delta.messageId);
  if (existing) {
    if (delta.content !== undefined) existing.content = delta.content;
    if (delta.thinking !== undefined) existing.thinking = delta.thinking;
    if (delta.toolCalls !== undefined) existing.toolCalls = delta.toolCalls;
    if (delta.toolCallId !== undefined) existing.toolCallId = delta.toolCallId;
    if (delta.toolName !== undefined) existing.toolName = delta.toolName;
    if (delta.model !== undefined) existing.model = delta.model;
    if (delta.provider !== undefined) existing.provider = delta.provider;
    if (delta.stopReason !== undefined) existing.stopReason = delta.stopReason;
  } else {
    messages.value.push({
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
    });
  }
}

// Wire up SSE. useSSE returns a controlled stream.
const sse = useSSE(`/api/sessions/${props.id}/events`);

sse.on('connected', () => {
  connected.value = true;
});

sse.on('message_update', (data: unknown) => {
  applyDelta(data as Parameters<typeof applyDelta>[0]);
});

sse.on('message_end', () => {
  // Worker has finished streaming this message; nothing extra to do (applyDelta already handled).
});

sse.on('tool_call', (data: unknown) => {
  // Merge tool call info into the latest assistant message.
  const d = data as { messageId: string; toolCalls?: ToolCallDTO[] };
  if (d.toolCalls) {
    const last = messages.value.find((m) => m.role === 'assistant');
    if (last) {
      last.toolCalls = [...(last.toolCalls ?? []), ...d.toolCalls];
    }
  }
});

sse.on('tool_result', (data: unknown) => {
  const d = data as { messageId: string; content?: string; toolCalls?: ToolCallDTO[] };
  // Update matching tool call's result.
  for (const msg of messages.value) {
    if (msg.toolCalls) {
      const tc = msg.toolCalls.find((c) => c.id === d.messageId);
      if (tc && d.toolCalls && d.toolCalls[0]) {
        tc.result = d.toolCalls[0].result ?? tc.result;
        tc.isError = d.toolCalls[0].isError ?? tc.isError;
      }
    }
  }
});

sse.on('agent_end', () => {
  sending.value = false;
});

sse.on('error', () => {
  connected.value = false;
});

onMounted(async () => {
  await loadHistory();
  await loadAgent();
  sse.connect();
});

onUnmounted(() => {
  sse.disconnect();
});

async function send() {
  const text = input.value.trim();
  if (!text || sending.value) return;
  const agentId = agentIdFromQuery.value ?? agent.value?.id;
  if (!agentId) {
    alert('Cannot resolve agent for this session');
    return;
  }
  sending.value = true;
  // Optimistic append
  messages.value.push({
    id: `local-${Date.now()}`,
    role: 'user',
    content: text,
    timestamp: Date.now(),
  });
  // Re-engage auto-scroll for the reply we're about to receive.
  autoScroll.value = true;
  const sent = input.value;
  input.value = '';

  try {
    const res = await fetch(`/api/sessions/${props.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, message: sent }),
    });
    if (!res.ok) throw new Error(`prompt failed: ${res.status}`);
  } catch (err) {
    sending.value = false;
    alert((err as Error).message);
  }
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

function isToolResult(msg: MessageDTO): boolean {
  return msg.role === 'toolResult';
}
</script>

<template>
  <div class="flex flex-col h-[calc(100vh-100px)]">
    <div class="flex items-center justify-between mb-2">
      <h2 class="text-xl font-semibold">Session {{ id.slice(0, 8) }}</h2>
      <span class="text-sm text-gray-500" :class="connected ? 'text-green-600' : 'text-red-600'">
        {{ connected ? '● connected' : '○ disconnected' }}
      </span>
    </div>

    <div
      ref="messagesEl"
      class="flex-1 overflow-y-auto space-y-3 mb-2 pr-2"
      @scroll="onMessagesScroll"
    >
      <template v-for="msg in messages" :key="msg.id">
        <!-- Tool result -->
        <div
          v-if="isToolResult(msg)"
          class="border border-gray-200 dark:border-gray-700 rounded p-3 ml-12 bg-gray-50 dark:bg-gray-900"
        >
          <div class="text-xs text-gray-500 mb-1">
            🔧 {{ msg.toolName ?? 'tool' }} result
            <span v-if="msg.toolCallId" class="ml-2">(call {{ msg.toolCallId.slice(0, 8) }})</span>
          </div>
          <pre class="text-xs whitespace-pre-wrap font-mono">{{ msg.content }}</pre>
        </div>

        <!-- User / Assistant -->
        <div
          v-else
          :class="[
            'p-3 rounded',
            msg.role === 'user'
              ? 'bg-blue-100 dark:bg-blue-900 ml-auto max-w-3xl'
              : 'bg-gray-100 dark:bg-gray-800 mr-auto max-w-3xl'
          ]"
        >
          <div class="text-xs text-gray-500 mb-1 flex items-center gap-2">
            <span class="font-medium">{{ msg.role }}</span>
            <span v-if="msg.model" class="text-[10px]">{{ msg.model }}</span>
          </div>

          <!-- Thinking (collapsible) -->
          <details v-if="msg.thinking" class="mb-2 text-xs text-gray-500">
            <summary class="cursor-pointer">💭 thinking</summary>
            <div class="mt-1 whitespace-pre-wrap pl-2 border-l-2 border-gray-300 dark:border-gray-600">
              {{ msg.thinking }}
            </div>
          </details>

          <div class="whitespace-pre-wrap">{{ msg.content }}</div>

          <!-- Tool calls -->
          <div v-if="msg.toolCalls && msg.toolCalls.length > 0" class="mt-2 space-y-2">
            <details
              v-for="tc in msg.toolCalls"
              :key="tc.id"
              class="border border-gray-300 dark:border-gray-600 rounded p-2 text-xs"
            >
              <summary class="cursor-pointer">
                🔧 {{ tc.name }} <span class="text-gray-400">({{ tc.id.slice(0, 8) }})</span>
                <span v-if="tc.isError" class="text-red-500 ml-2">error</span>
              </summary>
              <div class="mt-1 pl-2 space-y-1">
                <div>
                  <span class="text-gray-500">args:</span>
                  <pre class="font-mono whitespace-pre-wrap">{{ JSON.stringify(tc.args, null, 2) }}</pre>
                </div>
                <div v-if="tc.result !== undefined">
                  <span class="text-gray-500">result:</span>
                  <pre class="font-mono whitespace-pre-wrap">{{ tc.result }}</pre>
                </div>
              </div>
            </details>
          </div>
        </div>
      </template>
    </div>

    <div class="border-t border-gray-200 dark:border-gray-700 pt-2 flex gap-2">
      <textarea
        v-model="input"
        class="flex-1 p-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 disabled:opacity-50"
        placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
        rows="2"
        :disabled="sending || !connected"
        @keydown="onKeyDown"
      />
      <button
        class="px-4 py-2 rounded bg-blue-500 text-white disabled:opacity-50"
        :disabled="sending || !connected || !input.trim()"
        @click="send"
      >
        {{ sending ? '…' : '⏵ Send' }}
      </button>
    </div>
  </div>
</template>