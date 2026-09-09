<script setup lang="ts">
withDefaults(
  defineProps<{
    name: string;
    size?: number;
    strokeWidth?: number;
  }>(),
  {
    size: 18,
    strokeWidth: 1.8,
  },
);
</script>

<template>
  <svg
    class="app-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'brand'">
      <path d="M5 7.25 12 3l7 4.25v9.5L12 21l-7-4.25z" />
      <path d="M8.5 9.3 12 7.2l3.5 2.1v4.4L12 15.8l-3.5-2.1z" />
      <path d="M12 15.8V21M15.5 13.7l3.5 2.1M8.5 13.7 5 15.8" />
    </template>
    <template v-else-if="name === 'agents'">
      <circle cx="12" cy="8" r="3.25" />
      <path d="M5.5 20c.35-3.35 2.55-5.25 6.5-5.25s6.15 1.9 6.5 5.25" />
      <path d="M9.5 8h.01M14.5 8h.01" />
    </template>
    <template v-else-if="name === 'sessions'">
      <path d="M4 5.75A2.75 2.75 0 0 1 6.75 3h10.5A2.75 2.75 0 0 1 20 5.75v7.5A2.75 2.75 0 0 1 17.25 16H10l-4.5 4v-4.4A2.75 2.75 0 0 1 4 13.25z" />
      <path d="M8 8h8M8 11.5h5" />
    </template>
    <template v-else-if="name === 'architecture'">
      <rect x="8.5" y="3" width="7" height="5" rx="1" />
      <rect x="2.5" y="16" width="7" height="5" rx="1" />
      <rect x="14.5" y="16" width="7" height="5" rx="1" />
      <path d="M12 8v4M6 16v-4h12v4" />
    </template>
    <template v-else-if="name === 'wechat'">
      <path d="M14.5 15.6c-1.1.55-2.4.85-3.8.85-4.25 0-7.7-2.75-7.7-6.15s3.45-6.15 7.7-6.15 7.7 2.75 7.7 6.15c0 .55-.1 1.1-.25 1.6" />
      <path d="m6.1 18.9.8-3.2M17.1 12.25c2.15 0 3.9 1.45 3.9 3.25s-1.75 3.25-3.9 3.25c-.65 0-1.25-.13-1.8-.37L13 19.75l.45-2.15a2.9 2.9 0 0 1-.25-4.05" />
      <path d="M8.2 9.4h.01M13.2 9.4h.01M16 15.5h.01M18.7 15.5h.01" />
    </template>
    <template v-else-if="name === 'qq'">
      <path d="M8.25 16.5c-.75 1.9-2 3.2-3.75 3.8.6-1.2.85-2.45.8-3.75C4.45 15.2 4 13.6 4 11.8 4 6.95 7.4 3 12 3s8 3.95 8 8.8c0 1.8-.45 3.4-1.3 4.75-.05 1.3.2 2.55.8 3.75-1.75-.6-3-1.9-3.75-3.8" />
      <path d="M8.25 16.5c1.1.65 2.35 1 3.75 1s2.65-.35 3.75-1M9.25 10h.01M14.75 10h.01M9.5 13.25c.75.45 1.6.68 2.5.68s1.75-.23 2.5-.68" />
    </template>
    <template v-else-if="name === 'sun'">
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </template>
    <template v-else-if="name === 'moon'">
      <path d="M20 15.4A8.5 8.5 0 0 1 8.6 4a8.5 8.5 0 1 0 11.4 11.4Z" />
    </template>
    <template v-else-if="name === 'plus'">
      <path d="M12 5v14M5 12h14" />
    </template>
    <template v-else-if="name === 'edit'">
      <path d="m14.75 5.25 4 4M5 19l2.1-.45L19 6.65A2.1 2.1 0 0 0 16.35 4L4.45 15.9z" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M4.5 7h15M9 7V4.5h6V7M7 7l.75 13h8.5L17 7M10 10.5v6M14 10.5v6" />
    </template>
    <template v-else-if="name === 'folder'">
      <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6A2.5 2.5 0 0 1 20.5 9.5v7A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z" />
    </template>
    <template v-else-if="name === 'model'">
      <path d="m12 3 8 4.5-8 4.5-8-4.5zM4 12l8 4.5 8-4.5M4 16.5l8 4.5 8-4.5" />
    </template>
    <template v-else-if="name === 'tools'">
      <path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.6 2.6-4-4z" />
    </template>
    <template v-else-if="name === 'refresh'">
      <path d="M20 7v5h-5M4 17v-5h5" />
      <path d="M6.1 8a7 7 0 0 1 11.7-1L20 12M4 12l2.2 5a7 7 0 0 0 11.7-1" />
    </template>
    <template v-else-if="name === 'chevron-left'">
      <path d="m15 18-6-6 6-6" />
    </template>
    <template v-else-if="name === 'chevron-right'">
      <path d="m9 18 6-6-6-6" />
    </template>
    <template v-else-if="name === 'arrow-left'">
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </template>
    <template v-else-if="name === 'send'">
      <path d="m21 3-7.2 18-3.1-7.7L3 10.2zM10.7 13.3 21 3" />
    </template>
    <template v-else-if="name === 'check'">
      <path d="m5 12 4.3 4.3L19 6.7" />
    </template>
    <template v-else-if="name === 'close'">
      <path d="m6 6 12 12M18 6 6 18" />
    </template>
    <template v-else-if="name === 'alert'">
      <path d="M10.3 4.2 2.7 18a2 2 0 0 0 1.75 3h15.1a2 2 0 0 0 1.75-3L13.7 4.2a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </template>
    <template v-else-if="name === 'code'">
      <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M14 4l-4 16" />
    </template>
    <template v-else-if="name === 'clock'">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </template>
    <template v-else-if="name === 'im'">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      <circle cx="8" cy="11" r="1" fill="currentColor" />
      <circle cx="12" cy="11" r="1" fill="currentColor" />
      <circle cx="16" cy="11" r="1" fill="currentColor" />
    </template>
    <template v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </template>
    <template v-else>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </template>
  </svg>
</template>

<style scoped>
.app-icon {
  display: block;
  flex: 0 0 auto;
}
</style>
