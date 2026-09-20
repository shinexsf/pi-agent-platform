<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue';

const open = ref(false);
const menuRef = ref<HTMLElement | null>(null);

function toggle() { open.value = !open.value; }
function close() { open.value = false; }

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close();
}

function onBackdrop(e: PointerEvent) {
  if (menuRef.value && !menuRef.value.contains(e.target as Node)) close();
}

function onMenuClick() {
  // allow click to propagate (menu item handler fires first), then close
  requestAnimationFrame(close);
}

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onBackdrop);
  document.removeEventListener('keydown', onKeydown);
});

// watch open state to add/remove listeners
import { watch } from 'vue';
watch(open, (v) => {
  if (v) {
    document.addEventListener('pointerdown', onBackdrop);
    document.addEventListener('keydown', onKeydown);
  } else {
    document.removeEventListener('pointerdown', onBackdrop);
    document.removeEventListener('keydown', onKeydown);
  }
});
</script>

<template>
  <div class="dropdown-wrapper" ref="menuRef">
    <button
      class="btn btn-secondary btn-icon dropdown-trigger"
      type="button"
      aria-haspopup="true"
      :aria-expanded="open"
      @click.stop="toggle"
    >
      <slot name="trigger">
        <span class="ellipsis-icon">⋯</span>
      </slot>
    </button>
    <Transition name="dd">
      <div v-if="open" class="dropdown-menu" @click="onMenuClick" role="menu">
        <slot />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.dropdown-wrapper {
  position: relative;
  flex: 0 0 auto;
}

.dropdown-trigger {
  min-width: 28px;
  min-height: 28px;
  border: 0 !important;
  background: transparent;
}

.ellipsis-icon {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 2px;
  line-height: 1;
}

.dropdown-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 140px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  padding: 4px 0;
  z-index: 200;
}

.dropdown-menu :deep(.dropdown-item) {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 0.88rem;
  text-align: left;
  cursor: pointer;
  transition: background 120ms;
}

.dropdown-menu :deep(.dropdown-item:hover) {
  background: var(--surface-hover);
}

.dropdown-menu :deep(.dropdown-item.is-danger) {
  color: var(--danger);
}

.dropdown-menu :deep(.dropdown-item.is-danger:hover) {
  background: var(--danger-soft);
}

/* transition */
.dd-enter-active,
.dd-leave-active {
  transition: opacity 120ms ease, transform 120ms ease;
}
.dd-enter-from,
.dd-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
