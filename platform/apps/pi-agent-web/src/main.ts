/**
 * Web app entry — Vue + Vue Router + Pinia.
 *
 * Routes:
 *   /agents         Agents list    (meta.navLabel="Agents")
 *   /sessions       Sessions list  (meta.navLabel="Sessions")
 *   /sessions/:id   Session detail
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
import SessionDetailView from './views/SessionDetailView.vue';
import {
  channelAdminRegistry,
  loadChannelManifest,
  buildImGatewayRoute,
} from './modules/im-gateway';

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
    path: '/sessions/:id',
    component: SessionDetailView,
    props: true,
    meta: {}, // no navLabel (sub-page)
  },
];

const router = createRouter({
  // SPA 部署在 server 的 /web/ 下。vue-router 的 history base 必须跟 vite
  // base 一致，否则 pushState 跳到 /agents（不带前缀），刷新后 server
  // 没 mount /agents → 404。
  history: createWebHistory('/web/'),
  routes: [
    ...baseRoutes,
    buildImGatewayRoute(channelAdminRegistry),
  ],
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
  // Prefer Vue Router's current route meta (set by buildImGatewayRoute)
  if (routerRef.router) {
    const matched = routerRef.router.currentRoute.value.matched;
    for (const r of matched) {
      const meta = r.meta as { channelType?: string };
      if (meta.channelType) return meta.channelType;
    }
  }
  // Fallback to URL parsing
  const path = window.location.pathname;
  const segments = path.split('/').filter(Boolean);
  if (segments[0] === 'im' && segments[1]) return segments[1];
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
