<script setup lang="ts">
import { useTheme } from '../../composables/useTheme';

defineProps<{ title: string }>();
const { theme, toggle } = useTheme();
</script>

<template>
  <header class="border-b border-gray-200 dark:border-gray-700 px-4 py-2 flex items-center justify-between">
    <h1 class="text-lg font-semibold">{{ title }}</h1>
    <button
      class="px-3 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
      @click="toggle"
    >
      {{ theme === 'dark' ? '☼ Light' : '☾ Dark' }}
    </button>
  </header>
</template>