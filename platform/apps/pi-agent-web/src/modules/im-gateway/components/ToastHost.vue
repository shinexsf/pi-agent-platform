<script setup lang="ts">
/**
 * ToastHost — global toast queue, listens for `im-gateway:toast` events.
 *
 * Place one instance at the app root (App.vue / AppShell.vue). Up to 5 toasts visible;
 * older toasts auto-dismiss after their durationMs.
 */
import { ref, onMounted, onBeforeUnmount } from 'vue';
import type { ToastOptions } from '@pi-agent-platform/channel-types';
import AppIcon from '../../../components/ui/AppIcon.vue';

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

function iconName(variant: ActiveToast['variant']): string {
  if (variant === 'success') return 'check';
  if (variant === 'error' || variant === 'warning') return 'alert';
  return 'brand';
}

onMounted(() => window.addEventListener('im-gateway:toast', handler));
onBeforeUnmount(() => window.removeEventListener('im-gateway:toast', handler));
</script>

<template>
  <div class="toast-host" aria-live="polite" aria-atomic="false">
    <transition-group name="toast" tag="div">
      <div
        v-for="t in toasts"
        :key="t.id"
        :class="['toast', `toast-${t.variant}`]"
        :role="t.variant === 'error' ? 'alert' : 'status'"
      >
        <span class="toast-icon"><AppIcon :name="iconName(t.variant)" :size="17" /></span>
        <span class="toast-message">{{ t.message }}</span>
        <button type="button" class="toast-close" :aria-label="`Dismiss: ${t.message}`" @click="dismiss(t.id)">
          <AppIcon name="close" :size="15" />
        </button>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: 82px;
  right: 18px;
  z-index: 9999;
  pointer-events: none;
}
.toast {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  pointer-events: auto;
  width: min(390px, calc(100vw - 32px));
  min-height: 48px;
  padding: 9px 10px 9px 12px;
  margin-bottom: 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  color: var(--text);
  box-shadow: var(--shadow-raised);
  font-size: 0.8rem;
  line-height: 1.45;
}
.toast-icon {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.toast-success .toast-icon { background: var(--success-soft); color: var(--success); }
.toast-warning .toast-icon { background: var(--warning-soft); color: var(--warning); }
.toast-error .toast-icon { background: var(--danger-soft); color: var(--danger); }
.toast-message { min-width: 0; }
.toast-close {
  display: grid;
  width: 30px;
  height: 30px;
  place-items: center;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}
.toast-close:hover { background: var(--surface-hover); color: var(--text); }
.toast-enter-active, .toast-leave-active { transition: opacity 200ms ease, transform 200ms cubic-bezier(0.16, 1, 0.3, 1); }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(16px); }

@media (max-width: 680px) {
  .toast-host { top: 112px; right: 16px; }
}
</style>
