<script setup lang="ts">
/**
 * ConfirmDialogHost — modal confirm dialog, listens for `im-gateway:confirm` events.
 *
 * Protocol (used by ApiFetchProvider.showConfirmDialog):
 *   1. ApiFetchProvider dispatches `im-gateway:confirm` with opts
 *      and registers a resolver on `window.__imConfirmResolver`
 *   2. This component sets window.__imConfirmResolver and renders the dialog
 *   3. User clicks → calls respond(confirmed) → invokes resolver
 */
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue';
import type { ConfirmDialogOptions } from '@pi-agent-platform/channel-types';
import AppIcon from '../../../components/ui/AppIcon.vue';

interface Pending {
  opts: ConfirmDialogOptions;
}

const pending = ref<Pending | null>(null);
const primaryButton = ref<HTMLButtonElement | null>(null);
let previousBodyOverflow = '';

const handler = async (e: Event) => {
  const opts = (e as CustomEvent<ConfirmDialogOptions>).detail;
  pending.value = { opts };
  previousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  await nextTick();
  primaryButton.value?.focus();
};

function respond(confirmed: boolean): void {
  const w = window as unknown as { __imConfirmResolver?: (v: boolean) => void };
  w.__imConfirmResolver?.(confirmed);
  w.__imConfirmResolver = undefined;
  pending.value = null;
  document.body.style.overflow = previousBodyOverflow;
}

const onKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && pending.value) respond(false);
};

onMounted(() => {
  window.addEventListener('im-gateway:confirm', handler);
  window.addEventListener('keydown', onKeyDown);
});
onBeforeUnmount(() => {
  window.removeEventListener('im-gateway:confirm', handler);
  window.removeEventListener('keydown', onKeyDown);
  document.body.style.overflow = previousBodyOverflow;
});
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog">
      <div v-if="pending" class="confirm-overlay" @click.self="respond(false)">
        <div
          class="confirm-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          :aria-describedby="pending.opts.message ? 'confirm-message' : undefined"
        >
          <span :class="['confirm-icon', { destructive: pending.opts.destructive }]">
            <AppIcon :name="pending.opts.destructive ? 'alert' : 'brand'" :size="22" />
          </span>
          <div class="confirm-copy">
            <h2 id="confirm-title">{{ pending.opts.title }}</h2>
            <p v-if="pending.opts.message" id="confirm-message">{{ pending.opts.message }}</p>
          </div>
          <div class="confirm-actions">
            <button class="btn btn-secondary" type="button" @click="respond(false)">
              {{ pending.opts.cancelText ?? 'Cancel' }}
            </button>
            <button
              ref="primaryButton"
              :class="['btn', pending.opts.destructive ? 'confirm-destructive' : 'btn-primary']"
              type="button"
              @click="respond(true)"
            >
              {{ pending.opts.confirmText ?? 'Confirm' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.confirm-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(7, 11, 18, 0.58);
  backdrop-filter: blur(5px);
  z-index: 10000;
}
.confirm-dialog {
  display: grid;
  width: min(100%, 440px);
  grid-template-columns: auto minmax(0, 1fr);
  gap: 15px;
  padding: 22px;
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  color: var(--text);
  box-shadow: 0 32px 90px -36px rgba(0, 0, 0, 0.8);
}
.confirm-icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  border-radius: 12px;
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.confirm-icon.destructive { background: var(--danger-soft); color: var(--danger); }
.confirm-copy { min-width: 0; }
.confirm-copy h2 {
  margin: 2px 0 0;
  font-size: 1.02rem;
  font-weight: 740;
  letter-spacing: -0.02em;
}
.confirm-copy p {
  margin: 8px 0 0;
  color: var(--text-secondary);
  font-size: 0.82rem;
  line-height: 1.55;
}
.confirm-actions {
  display: flex;
  grid-column: 1 / -1;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 7px;
}
.confirm-destructive {
  background: var(--danger);
  color: #fff;
}
.confirm-destructive:hover { background: var(--danger-hover); }
.dialog-enter-active, .dialog-leave-active {
  transition: opacity 180ms ease;
}
.dialog-enter-active .confirm-dialog, .dialog-leave-active .confirm-dialog {
  transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1), opacity 180ms ease;
}
.dialog-enter-from, .dialog-leave-to { opacity: 0; }
.dialog-enter-from .confirm-dialog, .dialog-leave-to .confirm-dialog {
  opacity: 0;
  transform: translateY(10px) scale(0.985);
}
</style>
