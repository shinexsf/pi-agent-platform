<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AppShell from './components/layout/AppShell.vue';

const route = useRoute();

// Chat页面（/chat/:id）不需要AppShell包裹
const isChatPage = computed(() => route.path.startsWith('/chat/'));
</script>

<template>
  <AppShell v-if="!isChatPage">
    <router-view />
  </AppShell>
  <router-view v-else />
</template>