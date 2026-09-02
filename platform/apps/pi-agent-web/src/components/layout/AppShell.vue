<script setup lang="ts">
/**
 * AppShell — top-level layout: brand + TopNav + theme + global feedback + main slot.
 *
 * TopNav stays data-driven through router metadata.
 */
import { useTheme } from '../../composables/useTheme';
import AppIcon from '../ui/AppIcon.vue';
import TopNav from '../../modules/im-gateway/components/TopNav.vue';
import ToastHost from '../../modules/im-gateway/components/ToastHost.vue';
import ConfirmDialogHost from '../../modules/im-gateway/components/ConfirmDialogHost.vue';

const { theme, toggle } = useTheme();
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="app-header-inner">
        <router-link class="app-brand" to="/agents" aria-label="pi-agent-platform home">
          <span class="app-brand-mark">
            <AppIcon name="brand" :size="21" :stroke-width="1.7" />
          </span>
          <span class="app-brand-copy">
            <strong>pi-agent-platform</strong>
          </span>
        </router-link>
        <TopNav />
        <button
          class="theme-toggle"
          type="button"
          :aria-label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
          @click="toggle"
        >
          <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" :size="18" />
          <span>{{ theme === 'dark' ? 'Light' : 'Dark' }}</span>
        </button>
      </div>
    </header>
    <main id="main-content" class="app-main" tabindex="-1">
      <slot />
    </main>
    <ToastHost />
    <ConfirmDialogHost />
  </div>
</template>
