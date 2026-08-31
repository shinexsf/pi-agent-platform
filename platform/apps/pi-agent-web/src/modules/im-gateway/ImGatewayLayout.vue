<script setup lang="ts">
/**
 * ImGatewayLayout — wraps all channel admin pages.
 *
 * Provides:
 *   - <ApiFetchProvider> (auto-prefixes apiFetch with /api/im/<channelType>)
 *   - <router-view> for the actual channel page
 *
 * channelType is derived from:
 *   1. route.meta.channelType (preferred — set by buildImGatewayRoute)
 *   2. URL path segment after /im/ (fallback — robust to meta stripping)
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import ApiFetchProvider from './components/ApiFetchProvider.vue';

const route = useRoute();

const channelType = computed<string>(() => {
  // 1. Try route.meta first (works in production build)
  const fromMeta = (route.meta as { channelType?: string }).channelType;
  if (fromMeta) return fromMeta;
  // 2. Fallback: parse from URL path (e.g. /im/wechat → "wechat")
  const segments = route.path.split('/').filter(Boolean);
  // segments: ['im', 'wechat']
  if (segments[0] === 'im' && segments[1]) return segments[1];
  return 'wechat';
});
</script>

<template>
  <div class="im-gateway-layout">
    <ApiFetchProvider :channelType="channelType">
      <router-view />
    </ApiFetchProvider>
  </div>
</template>

<style scoped>
.im-gateway-layout {
  display: block;
  width: 100%;
}
</style>