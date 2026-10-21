<script setup lang="ts">
/**
 * InfoTip — 标题旁的小 `i` 图标，点击弹出说明气泡（点空白处 / Esc 关闭）。
 *
 * 页面里的长段说明文字统一收进这里，避免把配置区堆成文档。
 */
import { onBeforeUnmount, ref } from 'vue';

const props = withDefaults(defineProps<{ text: string; width?: number; label?: string }>(), {
  width: 300,
  label: '查看说明',
});

const open = ref(false);
const root = ref<HTMLElement | null>(null);

function onDocClick(event: MouseEvent): void {
  if (!root.value) return;
  if (!root.value.contains(event.target as Node)) open.value = false;
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') open.value = false;
}

function toggle(): void {
  open.value = !open.value;
  if (open.value) {
    document.addEventListener('click', onDocClick, true);
    document.addEventListener('keydown', onKey);
  } else {
    teardown();
  }
}

function teardown(): void {
  document.removeEventListener('click', onDocClick, true);
  document.removeEventListener('keydown', onKey);
}

onBeforeUnmount(teardown);
</script>

<template>
  <span ref="root" class="infotip">
    <button
      type="button"
      class="infotip-btn"
      :class="{ 'is-open': open }"
      :aria-label="props.label"
      :aria-expanded="open"
      @click.stop="toggle"
    >
      i
    </button>
    <span v-if="open" class="infotip-pop" role="tooltip" :style="{ width: props.width + 'px' }">
      {{ props.text }}
    </span>
  </span>
</template>

<style scoped>
.infotip {
  position: relative;
  display: inline-flex;
  align-items: center;
  vertical-align: middle;
}

.infotip-btn {
  width: 15px;
  height: 15px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-tertiary);
  font-size: 10px;
  font-style: italic;
  font-weight: 700;
  line-height: 1;
  font-family: Georgia, 'Times New Roman', serif;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s ease, border-color 0.15s ease;
}

.infotip-btn:hover,
.infotip-btn.is-open {
  color: var(--text);
  border-color: var(--text-tertiary);
}

.infotip-pop {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 40;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle);
  background: var(--surface-raised, var(--surface, #1b1d22));
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  color: var(--text-secondary);
  font-size: 0.74rem;
  font-weight: 400;
  line-height: 1.6;
  white-space: normal;
  text-align: left;
}
</style>
