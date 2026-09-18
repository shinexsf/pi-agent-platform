<script setup lang="ts">
/**
 * FloatingToolbar — vertically arranged icon buttons on the right edge of the chat.
 *
 * Default state: low opacity (0.35) so it's unobtrusive.
 * Hover: opacity transitions to 1.0.
 * Each button opens its own modal/panel.
 *
 * Currently contains:
 *   - ℹ️ (info) → SessionInfoModal
 */
import { ref } from 'vue'
import SessionInfoModal from './SessionInfoModal.vue'

const props = defineProps<{
  sessionId: string
}>()

const showSessionInfo = ref(false)
</script>

<template>
  <div class="floating-toolbar">
    <button
      class="toolbar-btn"
      title="Session Info"
      aria-label="Session Info"
      @click="showSessionInfo = true"
    >
      <!-- Info (i) icon — simple circle with i. 尺寸/描边对齐 IDE 原生工具窗图标
           （16px 描边 1.8，不是 18px/2） -->
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    </button>
  </div>

  <!-- Session Info Modal -->
  <Teleport to="body">
    <SessionInfoModal
      v-if="showSessionInfo"
      :session-id="sessionId"
      @close="showSessionInfo = false"
    />
  </Teleport>
</template>

<style scoped>
.floating-toolbar {
  position: fixed;
  /* 贴右边：JCEF 面板右缘只留 2px，跟 IDE 右侧工具窗图标列尽量对齐 */
  right: 2px;
  top: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  z-index: 100;
  opacity: 0.35;
  transition: opacity 0.2s ease;
}

.floating-toolbar:hover {
  opacity: 1;
}

.toolbar-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 5px;
  padding: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 0.15s, color 0.15s;
}

.toolbar-btn:hover {
  background: var(--hover-bg-strong);
  color: var(--text-primary);
}
</style>
