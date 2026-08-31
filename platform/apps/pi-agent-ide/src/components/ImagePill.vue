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
  background: rgba(128, 128, 128, 0.12);
  border: 1px solid rgba(128, 128, 128, 0.25);
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
  color: #c0392b;
}

.pill-x:focus-visible {
  outline: 2px solid rgba(255, 80, 80, 0.55);
  outline-offset: 1px;
}
</style>
