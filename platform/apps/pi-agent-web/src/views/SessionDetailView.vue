<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import type { AgentDTO, MessageDTO, ToolCallDTO } from '@pi-agent-platform/shared-types';
import { useSSE } from '../composables/useSSE';
import AppIcon from '../components/ui/AppIcon.vue';

const props = defineProps<{ id: string }>();
const route = useRoute();

const messages = ref<MessageDTO[]>([]);
const input = ref('');
const connected = ref(false);
const sending = ref(false);
const historyLoading = ref(true);
const historyError = ref<string | null>(null);
const agent = ref<AgentDTO | null>(null);
const messagesEl = ref<HTMLElement | null>(null);
const composerEl = ref<HTMLTextAreaElement | null>(null);
const autoScroll = ref(true);

const agentIdFromQuery = computed<string | null>(() => {
  const value = route.query.agentId;
  return typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
});

function showToast(message: string, variant: 'info' | 'success' | 'error' = 'info') {
  window.dispatchEvent(new CustomEvent('im-gateway:toast', { detail: { message, variant } }));
}

function onMessagesScroll() {
  const element = messagesEl.value;
  if (!element) return;
  autoScroll.value = element.scrollHeight - element.scrollTop - element.clientHeight < 56;
}

function scrollToBottom(smooth = true) {
  const element = messagesEl.value;
  if (!element) return;
  element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  autoScroll.value = true;
}

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

async function loadAgent(): Promise<string | null> {
  try {
    let id = agentIdFromQuery.value;
    if (!id) {
      const response = await fetch(`/api/sessions/${props.id}`);
      const session = response.ok ? await response.json() : null;
      if (session?.agentId) id = session.agentId as string;
    }
    if (!id) return null;

    const response = await fetch(`/api/agents/${id}`);
    if (response.ok) agent.value = await response.json();
    return id;
  } catch {
    return null;
  }
}

async function loadHistory(): Promise<void> {
  historyLoading.value = true;
  historyError.value = null;
  try {
    const response = await fetch(`/api/sessions/${props.id}/messages`);
    if (!response.ok) {
      if (response.status === 404) {
        messages.value = [];
        return;
      }
      throw new Error(`The server returned ${response.status}.`);
    }
    const data = (await response.json()) as { messages: MessageDTO[] };
    messages.value = data.messages;
  } catch {
    historyError.value = 'Message history couldn\'t be loaded. Check the server connection and try again.';
  } finally {
    historyLoading.value = false;
  }
}

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
  const existing = messages.value.find((message) => message.id === delta.messageId);
  if (existing) {
    if (delta.content !== undefined) existing.content = delta.content;
    if (delta.thinking !== undefined) existing.thinking = delta.thinking;
    if (delta.toolCalls !== undefined) existing.toolCalls = delta.toolCalls;
    if (delta.toolCallId !== undefined) existing.toolCallId = delta.toolCallId;
    if (delta.toolName !== undefined) existing.toolName = delta.toolName;
    if (delta.model !== undefined) existing.model = delta.model;
    if (delta.provider !== undefined) existing.provider = delta.provider;
    if (delta.stopReason !== undefined) existing.stopReason = delta.stopReason;
    return;
  }

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

const sse = useSSE(`/api/sessions/${props.id}/events`);

sse.on('connected', () => {
  connected.value = true;
});

sse.on('message_update', (data: unknown) => {
  applyDelta(data as Parameters<typeof applyDelta>[0]);
});

sse.on('tool_call', (data: unknown) => {
  const payload = data as { messageId: string; toolCalls?: ToolCallDTO[] };
  if (!payload.toolCalls) return;
  const lastAssistant = [...messages.value].reverse().find((message) => message.role === 'assistant');
  if (lastAssistant) lastAssistant.toolCalls = [...(lastAssistant.toolCalls ?? []), ...payload.toolCalls];
});

sse.on('tool_result', (data: unknown) => {
  const payload = data as { messageId: string; toolCalls?: ToolCallDTO[] };
  for (const message of messages.value) {
    const toolCall = message.toolCalls?.find((call) => call.id === payload.messageId);
    if (toolCall && payload.toolCalls?.[0]) {
      toolCall.result = payload.toolCalls[0].result ?? toolCall.result;
      toolCall.isError = payload.toolCalls[0].isError ?? toolCall.isError;
    }
  }
});

sse.on('agent_end', () => {
  sending.value = false;
});

sse.on('error', () => {
  connected.value = false;
  sending.value = false;
});

onMounted(async () => {
  await Promise.all([loadHistory(), loadAgent()]);
  sse.connect();
  await nextTick();
  scrollToBottom(false);
});

onUnmounted(() => {
  sse.disconnect();
});

async function send() {
  const text = input.value.trim();
  if (!text || sending.value || !connected.value) return;
  const agentId = agentIdFromQuery.value ?? agent.value?.id;
  if (!agentId) {
    showToast('This session has no Agent assignment. Return to Sessions and reopen it.', 'error');
    return;
  }

  sending.value = true;
  const localId = `local-${Date.now()}`;
  const sent = input.value;
  messages.value.push({
    id: localId,
    role: 'user',
    content: text,
    timestamp: Date.now(),
  });
  input.value = '';
  autoScroll.value = true;

  try {
    const response = await fetch(`/api/sessions/${props.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, message: sent }),
    });
    if (!response.ok) {
      throw new Error(`The server returned ${response.status}.`);
    }
  } catch (err) {
    messages.value = messages.value.filter((message) => message.id !== localId);
    input.value = sent;
    sending.value = false;
    const detail = err instanceof Error && err.message.startsWith('The server returned') ? ` ${err.message}` : '';
    showToast(`Message couldn't be sent. Your draft has been restored. Check the connection and try again.${detail}`, 'error');
    await nextTick();
    composerEl.value?.focus();
  }
}

function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}

function isToolResult(message: MessageDTO): boolean {
  return message.role === 'toolResult';
}

function roleLabel(role: MessageDTO['role']): string {
  if (role === 'assistant') return 'Agent';
  if (role === 'user') return 'You';
  if (role === 'toolResult') return 'Tool';
  return role;
}

function sessionTransitionName(id: string): string {
  return `session-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

</script>

<template>
  <section class="session-page" :aria-label="`Session ${id.slice(0, 8)}`">
    <header class="session-header" :style="{ viewTransitionName: sessionTransitionName(id) }">
      <div class="session-title-group">
        <router-link class="btn btn-ghost btn-icon" to="/sessions" aria-label="Back to sessions">
          <AppIcon name="arrow-left" :size="18" />
        </router-link>
        <div>
          <h1>Session {{ id.slice(0, 8) }}</h1>
        </div>
      </div>
      <span
        :class="['status-badge', connected ? 'is-live' : 'is-error']"
        role="status"
        aria-live="polite"
      >
        {{ connected ? 'Connected' : 'Connecting…' }}
      </span>
    </header>

    <div class="chat-surface">
      <div class="message-viewport">
        <div ref="messagesEl" class="message-scroll" @scroll="onMessagesScroll">
          <div v-if="historyLoading" class="message-loading" aria-live="polite">
            <span class="sr-only">Loading message history…</span>
            <span class="message-loading-dot" />
            <span class="message-loading-dot" />
            <span class="message-loading-dot" />
          </div>

          <div v-else-if="historyError" class="state-panel compact">
            <div class="state-content">
              <span class="state-icon"><AppIcon name="alert" :size="23" /></span>
              <h2 class="state-title">History unavailable</h2>
              <p class="state-copy">{{ historyError }}</p>
              <button class="btn btn-secondary state-action" type="button" @click="loadHistory">Try again</button>
            </div>
          </div>

          <div v-else-if="messages.length === 0" class="state-panel compact">
            <div class="state-content">
              <span class="state-icon"><AppIcon name="sessions" :size="23" /></span>
              <h2 class="state-title">No messages yet</h2>
              <p class="state-copy">Send a message to start this session.</p>
            </div>
          </div>

          <div v-else class="message-list" aria-live="polite" aria-relevant="additions text">
            <template v-for="message in messages" :key="message.id">
              <article v-if="isToolResult(message)" class="tool-result">
                <header class="tool-header">
                  <span>
                    <AppIcon name="tools" :size="15" />
                    {{ message.toolName ?? 'Tool' }} result
                    <span v-if="message.toolCallId">(call {{ message.toolCallId.slice(0, 8) }})</span>
                  </span>
                </header>
                <pre>{{ message.content }}</pre>
              </article>

              <article
                v-else
                :class="['message-row', `is-${message.role}`]"
                :aria-label="roleLabel(message.role)"
              >
                <div class="message-bubble">
                  <header class="message-meta">
                    <strong>{{ roleLabel(message.role) }}</strong>
                    <span v-if="message.model" class="mono">{{ message.model }}</span>
                  </header>

                  <details v-if="message.thinking" class="thinking-panel">
                    <summary>
                      <AppIcon name="code" :size="14" />
                      Reasoning
                    </summary>
                    <div>{{ message.thinking }}</div>
                  </details>

                  <div v-if="message.content" class="message-content">{{ message.content }}</div>

                  <div v-if="message.toolCalls?.length" class="tool-call-list">
                    <details
                      v-for="toolCall in message.toolCalls"
                      :key="toolCall.id"
                      :class="['tool-call', { 'is-error': toolCall.isError }]"
                    >
                      <summary>
                        <span>
                          <AppIcon name="tools" :size="14" />
                          {{ toolCall.name }} <span class="mono">({{ toolCall.id.slice(0, 8) }})</span>
                        </span>
                        <span v-if="toolCall.isError" class="tool-call-status">Failed</span>
                      </summary>
                      <div class="tool-call-body">
                        <div>
                          <span class="tool-label">Arguments</span>
                          <pre>{{ JSON.stringify(toolCall.args, null, 2) }}</pre>
                        </div>
                        <div v-if="toolCall.result !== undefined">
                          <span class="tool-label">Result</span>
                          <pre>{{ toolCall.result }}</pre>
                        </div>
                      </div>
                    </details>
                  </div>
                </div>
              </article>
            </template>
          </div>
        </div>

        <button
          v-if="!autoScroll"
          class="btn btn-secondary btn-icon scroll-latest"
          type="button"
          aria-label="Latest message"
          @click="scrollToBottom()"
        >
          <AppIcon name="chevron-right" :size="15" class="rotate-down" />
        </button>
      </div>

      <form class="composer" @submit.prevent="send">
        <label class="composer-field">
          <span class="sr-only">Message</span>
          <textarea
            ref="composerEl"
            v-model="input"
            class="composer-input"
            :placeholder="connected ? 'Message the Agent' : 'Waiting for connection…'"
            rows="2"
            :disabled="sending || !connected"
            @keydown="onKeyDown"
          />
          <span class="composer-hint">Enter to send · Shift+Enter for a new line</span>
        </label>
        <button
          class="btn btn-primary composer-send"
          type="submit"
          :class="{ 'is-loading': sending }"
          :disabled="sending || !connected || !input.trim()"
        >
          <AppIcon :name="sending ? 'refresh' : 'send'" :size="17" />
          <span>{{ sending ? '…' : 'Send' }}</span>
        </button>
      </form>
    </div>
  </section>
</template>

<style scoped>
.session-page {
  display: grid;
  height: calc(100dvh - 176px);
  min-height: 620px;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 18px;
}

.session-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}

.session-title-group {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
}

.session-title-group > div {
  min-width: 0;
}

.session-title-group h1 {
  overflow: hidden;
  margin: 0;
  color: var(--text);
  font-size: 1.14rem;
  font-weight: 740;
  letter-spacing: -0.025em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-surface {
  display: grid;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr) auto;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-soft);
}

.message-viewport {
  position: relative;
  min-height: 0;
}

.message-scroll {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: var(--surface-subtle);
  scroll-behavior: smooth;
}

.message-list {
  display: grid;
  width: min(100%, 920px);
  margin: 0 auto;
  padding: 30px 24px 38px;
  gap: 22px;
}

.message-row {
  display: flex;
  width: 100%;
  justify-content: flex-start;
}

.message-row.is-user {
  justify-content: flex-end;
}

.message-bubble {
  max-width: min(78%, 720px);
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 10px 24px -24px rgba(20, 31, 49, 0.8);
}

.is-user .message-bubble {
  border-color: transparent;
  background: var(--accent);
  color: #fff;
}

.is-error .message-bubble {
  border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
  background: var(--danger-soft);
  color: var(--danger);
}

.message-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  color: var(--text-tertiary);
  font-size: 0.66rem;
}

.message-meta strong {
  color: var(--text-secondary);
  font-size: 0.72rem;
}

.is-user .message-meta,
.is-user .message-meta strong {
  color: color-mix(in srgb, #fff 82%, var(--accent));
}

.message-content {
  overflow-wrap: anywhere;
  font-size: 0.88rem;
  line-height: 1.65;
  white-space: pre-wrap;
}

.thinking-panel {
  margin: 3px 0 11px;
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.thinking-panel summary,
.tool-call summary {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  user-select: none;
}

.thinking-panel > div {
  margin-top: 9px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: var(--surface-subtle);
  line-height: 1.55;
  white-space: pre-wrap;
}

.tool-call-list {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}

.tool-call {
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-subtle);
  color: var(--text-secondary);
  font-size: 0.75rem;
}

.tool-call.is-error {
  border-color: color-mix(in srgb, var(--danger) 32%, var(--border));
}

.tool-call > summary {
  justify-content: space-between;
  min-height: 38px;
  padding: 8px 10px;
}

.tool-call > summary > span:first-child {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text);
  font-weight: 650;
}

.tool-call-status {
  color: var(--text-tertiary);
  font-size: 0.67rem;
}

.tool-call.is-error .tool-call-status {
  color: var(--danger);
}

.tool-call-body {
  display: grid;
  gap: 13px;
  padding: 12px;
  border-top: 1px solid var(--border);
}

.tool-label {
  display: block;
  margin-bottom: 6px;
  color: var(--text-tertiary);
  font-size: 0.65rem;
  font-weight: 700;
}

.tool-call pre,
.tool-result pre {
  max-height: 320px;
  margin: 0;
  overflow: auto;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.7rem;
  line-height: 1.55;
  white-space: pre-wrap;
}

.tool-result {
  width: min(calc(100% - 48px), 780px);
  margin: 0 auto;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.tool-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-hover);
  color: var(--text-secondary);
  font-size: 0.72rem;
}

.tool-header > span:first-child {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--text);
  font-weight: 650;
}

.tool-result > pre {
  padding: 12px;
}

.message-loading {
  display: flex;
  min-height: 100%;
  align-items: center;
  justify-content: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 0.78rem;
}

.message-loading-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: pulse 900ms ease-in-out infinite alternate;
}

.message-loading-dot:nth-child(2) { animation-delay: 130ms; }
.message-loading-dot:nth-child(3) { animation-delay: 260ms; margin-right: 5px; }

@keyframes pulse {
  to { opacity: 0.3; transform: translateY(-3px); }
}

.state-panel.compact {
  min-height: 100%;
}

.empty-message-space {
  min-height: 100%;
}

.scroll-latest {
  position: absolute;
  right: 18px;
  bottom: 16px;
  min-height: 34px;
  border-color: var(--border-strong);
  box-shadow: var(--shadow-raised);
}

.rotate-down {
  transform: rotate(90deg);
}

.composer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 12px;
  padding: 14px;
  border-top: 1px solid var(--border);
  background: var(--surface);
}

.composer-field {
  display: grid;
  min-width: 0;
}

.composer-hint {
  margin: 6px 2px 0;
  color: var(--text-tertiary);
  font-size: 0.69rem;
}

.composer-input {
  width: 100%;
  min-height: 48px;
  max-height: 180px;
  padding: 11px 12px;
  resize: vertical;
  border: 1px solid var(--border-strong);
  border-radius: 11px;
  background: var(--surface-subtle);
  color: var(--text);
  caret-color: var(--accent);
  font-size: 0.86rem;
  line-height: 1.45;
}

.composer-input::placeholder {
  color: var(--text-tertiary);
}

.composer-input:focus {
  border-color: var(--accent);
  outline: 0;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 24%, transparent);
}

.composer-input:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.composer-send {
  align-self: start;
  min-width: 92px;
  min-height: 48px;
}

@media (max-width: 680px) {
  .session-page {
    height: calc(100dvh - 166px);
    min-height: 540px;
  }

  .session-header {
    gap: 10px;
  }

  .message-list {
    padding: 22px 13px 30px;
    gap: 17px;
  }

  .message-bubble {
    max-width: 91%;
  }

  .tool-result {
    width: calc(100% - 26px);
  }

  .composer {
    grid-template-columns: minmax(0, 1fr) 48px;
    gap: 8px;
    padding: 10px;
  }

  .composer-send {
    min-width: 48px;
    width: 48px;
    padding: 0;
  }

  .composer-send span {
    display: none;
  }

  .composer-hint {
    display: none;
  }

  .composer-input {
    padding-bottom: 11px;
  }
}
</style>
