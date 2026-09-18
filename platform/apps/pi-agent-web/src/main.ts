/**
 * Web app entry — Vue + Vue Router + Pinia.
 *
 * Routes:
 *   /agents         Agents list    (meta.navLabel="Agents")
 *   /sessions       Sessions list  (meta.navLabel="Sessions")
 *   /sessions/:id   Session detail
 *   /architecture   Interactive project architecture
 *   /im/*           Channel admin pages (auto-discovered via import.meta.glob)
 *
 * Channel admin pages consume `window.__channelAdminHost` (set below) which
 * wraps `fetch('/api/im/<channelType>/...')` calls.
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory, type Router } from 'vue-router';
import App from './App.vue';
import './style.css';
import { installRouteTransitions } from './motion/routeTransitions';

// Forward-declared so function closures (created below) can reference it
// before the router is constructed later in this file.
const routerRef: { router: import('vue-router').Router | null } = { router: null };
import AgentsListView from './views/AgentsListView.vue';
import SessionsListView from './views/SessionsListView.vue';

import {
  channelAdminRegistry,
  loadChannelManifest,
} from './modules/im-gateway';
import ChannelsView from './views/im/ChannelsView.vue';
import ConfigView from './views/config/ConfigView.vue';

// Step 1: base routes (data-driven navLabel for TopNav)
const baseRoutes = [
  { path: '/', redirect: '/agents' },
  {
    path: '/agents',
    component: AgentsListView,
    meta: { navLabel: 'Agents', navOrder: 10, navIcon: 'agents' },
  },
  {
    path: '/sessions',
    component: SessionsListView,
    meta: { navLabel: 'Sessions', navOrder: 20, navIcon: 'sessions' },
  },
  {
    path: '/architecture',
    component: () => import('./views/ArchitectureView.vue'),
    meta: { navLabel: '架构图', navOrder: 90, navIcon: 'architecture', fullWidth: true },
  },
  {
    path: '/im',
    component: ChannelsView,
    meta: { navLabel: 'IM', navOrder: 30, navIcon: 'im' },
  },
  {
    path: '/config',
    component: ConfigView,
    meta: { navLabel: '配置', navOrder: 50, navIcon: 'settings' },
  },

  {
    path: '/chat/:id',
    component: () => import('./views/ChatView.vue'),
    // chat 页在 App.vue 里走 isChatPage 分支，不套 AppShell（无 app-main），
    // 自管整页布局，所以这里不需要 fullWidth。
    meta: {}, // no navLabel (sub-page)
  },
];

const router = createRouter({
  // 跟随 Vite 的 base：开发环境为 /，Server 托管构建产物时为 /web/。
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [...baseRoutes],
});
routerRef.router = router;
installRouteTransitions(router);

// Set up the global ChannelAdminHost object so channel admin pages can use
// window.__channelAdminHost.apiFetch() etc. The current channel type is
// derived from the route meta, falling back to URL parsing.
import type { ChannelAdminHost, ChannelLogEvent, ToastOptions, ConfirmDialogOptions } from '@pi-agent-platform/channel-types';

// (routerRef is forward-declared above to be visible to function closures
//  created before the router is constructed.)

function currentChannelType(): string {
  // 优先使用 ChannelsView 设置的全局 channelType
  const global = (window as any).__currentChannelType;
  if (global) return global;
  // 从 URL 解析
  const path = window.location.pathname;
  const segments = path.split('/').filter(Boolean);
  return segments[1] || 'wechat';
}

const globalHost: ChannelAdminHost = {
  apiFetch: async (method, path, body) => {
    const channelType = currentChannelType();
    const url = `/api/im/${channelType}${path.startsWith('/') ? path : '/' + path}`;
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

(window as unknown as { __channelAdminHost?: ChannelAdminHost }).__channelAdminHost = globalHost;
(window as unknown as { __channelAdminRegistry?: unknown }).__channelAdminRegistry = channelAdminRegistry;

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');

// Async: log manifest mismatch (filtered vs total)
loadChannelManifest().then((filtered) => {
  if (filtered.length !== channelAdminRegistry.length) {
    console.info(`[im-gateway] ${filtered.length}/${channelAdminRegistry.length} channels enabled`);
  }
});

// Re-export so the import isn't dead-code eliminated (used by ApiFetchProvider).
void globalHost;
