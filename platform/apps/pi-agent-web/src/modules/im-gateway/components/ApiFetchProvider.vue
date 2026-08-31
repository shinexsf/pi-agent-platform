<script setup lang="ts">
/**
 * ApiFetchProvider — wraps admin pages and injects apiFetch via window.__channelAdminHost.
 *
 * Channel pages use `useChannelAdminHost()` to get apiFetch which automatically
 * pre-pends the channel-type prefix from the route.
 */
import { provide, onMounted, ref } from 'vue';
import type { ChannelAdminHost, ToastOptions, ConfirmDialogOptions } from '@pi-agent-platform/channel-types';
import { ChannelAdminHostKey } from '../channel-admin';

const props = defineProps<{
  channelType: string;
}>();

const ready = ref(false);
const error = ref<string | null>(null);

const host: ChannelAdminHost = {
  apiFetch: async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => {
    const prefix = `/api/im/${props.channelType}`;
    const url = path.startsWith('/') ? `${prefix}${path}` : `${prefix}/${path}`;
    const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${url} → ${res.status} ${text}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) return await res.json();
    return await res.text();
  },
  showToast: (opts: ToastOptions) => {
    window.dispatchEvent(new CustomEvent('im-gateway:toast', { detail: opts }));
  },
  showConfirmDialog: (opts: ConfirmDialogOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      const w = window as unknown as { __imConfirmResolver?: (v: boolean) => void };
      w.__imConfirmResolver = resolve;
      window.dispatchEvent(new CustomEvent('im-gateway:confirm', { detail: opts }));
    });
  },
  useI18n: () => {
    // MVP: stub i18n (returns key as-is). Future: wire to i18next or vue-i18n.
    const cache = new Map<string, string>();
    return {
      t: (key: string, params?: Record<string, unknown>) => {
        const cached = cache.get(key);
        if (cached) return interpolate(cached, params);
        cache.set(key, key);
        return interpolate(key, params);
      },
    };
  },
};

function interpolate(template: string, params?: Record<string, unknown>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
}

provide(ChannelAdminHostKey, host);

onMounted(() => {
  ready.value = true;
});
</script>

<template>
  <div class="api-fetch-provider">
    <div v-if="error" class="error">{{ error }}</div>
    <slot v-else />
  </div>
</template>

<style scoped>
.api-fetch-provider { display: contents; }
.error { background: #fee; color: #c00; padding: 12px; border-radius: 6px; }
</style>