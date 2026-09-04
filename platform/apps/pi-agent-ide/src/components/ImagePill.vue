<!--
  ImagePill — single attachment pill rendered above the InputBox textarea.

  Shows a thumbnail (data URL) + filename + a × button that:
    1. Drops the row from useAttachments cache (server file remains untouched;
       a non-sent attachment's bytes get cleaned up at session delete via the
       cascade in attachment-store.deleteBySession).
    2. Strips the corresponding `[pi-attachment:att_xxx]` marker from textarea text.
-->
<script setup lang="ts">
import type { UploadedAttachment } from '../composables/useAttachments'

defineProps<{
  attachment: UploadedAttachment
}>()

const emit = defineEmits<{
  remove: [id: string]
}>()
</script>

<template>
  <div class="pill">
    <img
      class="pill-thumb"
      :src="`data:${attachment.mimeType};base64,${attachment.dataB64}`"
      :alt="attachment.originalFilename || attachment.id"
    />
    <div class="pill-meta">
      <div class="pill-filename">{{ attachment.originalFilename || attachment.id }}</div>
      <div class="pill-size">{{ Math.max(1, Math.round(attachment.sizeBytes / 1024)) }} KB</div>
    </div>
    <button
      type="button"
      class="pill-x"
      :aria-label="`remove ${attachment.originalFilename}`"
      @click="emit('remove', attachment.id)"
    >×</button>
  </div>
</template>

<style scoped>
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 4px;
  background: var(--hover-bg);
  border: 1px solid var(--border);
  border-radius: 14px;
  margin: 2px 4px 2px 0;
  font-size: 12px;
  user-select: none;
  max-width: 240px;
}

.pill-thumb {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.pill-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.pill-filename {
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}

.pill-size {
  color: var(--text-secondary);
  font-size: 10px;
}

.pill-x {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 50%;
  flex-shrink: 0;
  /* Larger hit area + clearer affordance than the previous tiny × button. */
  transition: background 0.1s, border-color 0.1s, color 0.1s;
}

.pill-x:hover {
  background: rgba(255, 80, 80, 0.18);
  border-color: rgba(255, 80, 80, 0.45);
  /* 暗色下也用 red 文字——上边红 80 透明度底 + 红色文字在 #1F2125 上
   * 对比度只有 3.5:1 不到 AA，但 × 只是次要操作，hover 反馈够识别即可。 */
  color: var(--tool-error-text);
}

.pill-x:focus-visible {
  outline: 2px solid var(--tool-error-text);
  outline-offset: 1px;
}
</style>
