<script setup lang="ts">
/**
 * Steer mode sub-bar (per C2 / D7).
 * Shown above the input box when there are queued messages.
 * Displays steering + followUp queues separately.
 */

const props = defineProps<{
  steering: string[]
}>()
</script>

<template>
  <div v-if="steering.length > 0" class="steer-bar">
    <div class="steer-section">
      <span class="steer-label">⚡ Steering</span>
      <div v-for="(msg, i) in steering" :key="'s' + i" class="steer-msg">
        <span class="steer-tag">interrupt</span>
        <span class="steer-text">{{ msg }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.steer-bar {
  border-top: 1px solid var(--border);
  background: var(--surface-hover);
  padding: 6px 12px 4px;
  max-height: 120px;
  overflow-y: auto;
}
.steer-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 4px;
}
.steer-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
}
.steer-msg {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 2px 4px;
  background: var(--surface-hover);
  border-radius: 3px;
}
.steer-tag {
  font-size: 9px;
  padding: 1px 4px;
  background: var(--accent);
  color: white;
  border-radius: 2px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.steer-text {
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>