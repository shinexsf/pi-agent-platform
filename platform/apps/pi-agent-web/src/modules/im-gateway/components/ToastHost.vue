<script setup lang="ts">
/**
 * ToastHost — global toast queue, listens for `im-gateway:toast` events.
 *
 * Place one instance at the app root (App.vue / AppShell.vue). Up to 5 toasts visible;
 * older toasts auto-dismiss after their durationMs.
 */
import { ref, onMounted, onBeforeUnmount } from 'vue';
import type { ToastOptions } from '@pi-agent-platform/channel-types';

interface ActiveToast extends Required<Pick<ToastOptions, 'variant' | 'durationMs'>> {
  id: number;
  message: string;
}

const toasts = ref<ActiveToast[]>([]);
let nextId = 1;
const handler = (e: Event) => {
  const opts = (e as CustomEvent<ToastOptions>).detail;
  add(opts);
};

function add(opts: ToastOptions): void {
  const id = nextId++;
  const variant = opts.variant ?? 'info';
  const durationMs = opts.durationMs ?? (variant === 'error' ? 8000 : 3000);
  toasts.value.push({ id, message: opts.message, variant, durationMs });
  if (toasts.value.length > 5) toasts.value.shift();
  setTimeout(() => dismiss(id), durationMs);
}

function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

onMounted(() => window.addEventListener('im-gateway:toast', handler));
onBeforeUnmount(() => window.removeEventListener('im-gateway:toast', handler));
</script>

<template>
  <div class="toast-host">
    <transition-group name="toast" tag="div">
      <div
        v-for="t in toasts"
        :key="t.id"
        :class="['toast', `toast-${t.variant}`]"
        @click="dismiss(t.id)"
      >
        {{ t.message }}
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-host { position: fixed; top: 64px; right: 16px; z-index: 9999; pointer-events: none; }
.toast {
  pointer-events: auto;
  padding: 10px 14px;
  margin-bottom: 8px;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  cursor: pointer;
  max-width: 360px;
  font-size: 14px;
}
.toast-info { background: #3b82f6; color: white; }
.toast-success { background: #10b981; color: white; }
.toast-warning { background: #f59e0b; color: white; }
.toast-error { background: #ef4444; color: white; }
.toast-enter-active, .toast-leave-active { transition: all 0.2s ease; }
.toast-enter-from { opacity: 0; transform: translateX(20px); }
.toast-leave-to { opacity: 0; transform: translateX(20px); }
</style>