<script setup lang="ts">
/**
 * AppShell — top-level layout: title + TopNav + ToastHost + ConfirmDialogHost + main slot.
 *
 * TopNav (data-driven, from router meta) replaces the old hardcoded TopBar.
 */
import { computed } from 'vue';
import { useTheme } from '../../composables/useTheme';
import TopNav from '../../modules/im-gateway/components/TopNav.vue';
import ToastHost from '../../modules/im-gateway/components/ToastHost.vue';
import ConfirmDialogHost from '../../modules/im-gateway/components/ConfirmDialogHost.vue';

const title = computed(() => 'pi-agent-platform');
const { theme, toggle } = useTheme();
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <header class="border-b border-gray-200 dark:border-gray-700 px-4 py-2 flex items-center justify-between">
      <h1 class="text-lg font-semibold">{{ title }}</h1>
      <button
        class="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
        @click="toggle"
      >
        {{ theme === 'dark' ? '☼ Light' : '☾ Dark' }}
      </button>
    </header>
    <TopNav />
    <main class="flex-1 p-4">
      <slot />
    </main>
    <ToastHost />
    <ConfirmDialogHost />
  </div>
</template>