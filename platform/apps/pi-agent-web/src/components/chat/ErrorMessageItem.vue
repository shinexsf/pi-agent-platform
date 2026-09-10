<script setup lang="ts">
/**
 * Inline error message item (per E1).
 * Inserted in the chat area (not top bar) when send fails or SSE drops.
 * Has a Retry button + close button.
 */
import type { MessageDTO } from '@pi-agent-platform/shared-types'

const props = defineProps<{
  message: MessageDTO
  agentId: string
}>()

const emit = defineEmits<{
  retry: [userMessageText: string, agentId: string]
  dismiss: []
}>()

function getErrorCtx() {
  return (props.message as any).__errorContext as
    | { source: string; relatedUserMessageText?: string; message: string }
    | undefined
}

function onRetry() {
  const ctx = getErrorCtx()
  const text = ctx?.relatedUserMessageText ?? ''
  if (text) emit('retry', text, props.agentId)
}
</script>

<template>
  <div class="error-item">
    <div class="error-header">
      <span class="error-icon">⚠</span>
      <span class="error-title">{{ getErrorCtx()?.source === 'sse_connection' ? 'Connection lost' : 'Send failed' }}</span>
      <button class="error-close" type="button" @click="emit('dismiss')" title="Dismiss">×</button>
    </div>
    <div class="error-msg">{{ getErrorCtx()?.message ?? message.content }}</div>
    <div class="error-actions">
      <button
        v-if="getErrorCtx()?.relatedUserMessageText"
        class="error-retry"
        type="button"
        @click="onRetry"
      >↻ Retry</button>
    </div>
  </div>
</template>

<style scoped>
.error-item {
  background: var(--danger-soft);
  border-left: 3px solid var(--danger);
  border-radius: 4px;
  padding: 8px 12px;
  margin: 4px 0;
  max-width: 80%;
}

.error-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 13px;
}

.error-icon {
  color: var(--danger);
  font-size: 14px;
}

.error-title {
  flex: 1;
  color: var(--text);
}

.error-close {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 16px;
  padding: 0 4px;
}
.error-close:hover {
  color: var(--text);
}

.error-msg {
  color: var(--text-secondary);
  font-size: 12px;
  margin: 4px 0;
  white-space: pre-wrap;
}

.error-actions {
  display: flex;
  gap: 6px;
}

.error-retry {
  background: var(--danger);
  /* 亮色下 red-500 + 白只有 3.66:1 (差 AA 0.84)；用 --on-error 切到
   * red 900 (6.4:1)。暗色下 --on-error = 白色，保持原观感。 */
  color: var(--on-error);
  border: none;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 500;
  border-radius: 3px;
  cursor: pointer;
}
.error-retry:hover {
  opacity: 0.85;
}
</style>