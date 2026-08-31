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
import { ref, onMounted, onBeforeUnmount } from 'vue';
import type { ConfirmDialogOptions } from '@pi-agent-platform/channel-types';

interface Pending {
  opts: ConfirmDialogOptions;
}

const pending = ref<Pending | null>(null);

const handler = (e: Event) => {
  const opts = (e as CustomEvent<ConfirmDialogOptions>).detail;
  pending.value = { opts };
};

function respond(confirmed: boolean): void {
  const w = window as unknown as { __imConfirmResolver?: (v: boolean) => void };
  w.__imConfirmResolver?.(confirmed);
  w.__imConfirmResolver = undefined;
  pending.value = null;
}

onMounted(() => window.addEventListener('im-gateway:confirm', handler));
onBeforeUnmount(() => window.removeEventListener('im-gateway:confirm', handler));
</script>

<template>
  <Teleport to="body">
    <div v-if="pending" class="confirm-overlay" @click.self="respond(false)">
      <div class="confirm-dialog">
        <h3>{{ pending.opts.title }}</h3>
        <p>{{ pending.opts.message }}</p>
        <div class="actions">
          <button @click="respond(false)">{{ pending.opts.cancelText ?? 'Cancel' }}</button>
          <button
            :class="{ destructive: pending.opts.destructive }"
            @click="respond(true)"
          >
            {{ pending.opts.confirmText ?? 'Confirm' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-overlay {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 10000;
}
.confirm-dialog {
  background: white; border-radius: 8px; padding: 24px;
  min-width: 360px; max-width: 480px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
}
.confirm-dialog h3 { margin: 0 0 12px; }
.confirm-dialog p { margin: 0 0 24px; color: #4b5563; }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
.actions button { padding: 8px 16px; border: 1px solid #d1d5db; background: white; border-radius: 4px; cursor: pointer; }
.actions button:hover { background: #f9fafb; }
.actions button.destructive { background: #ef4444; color: white; border-color: #ef4444; }
.actions button.destructive:hover { background: #dc2626; }
</style>