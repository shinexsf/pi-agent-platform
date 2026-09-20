/**
 * Web app entry — Vue + Vue Router + Pinia.
 *
 * 导航由 `components/layout/nav-tree.ts` 从路由 `meta.navLabel` 推导；
 * 面包屑由 `meta.crumbTitle` / `meta.crumbTitleFromParam` 补充最后一段。
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
import ModelsConfig from './views/config/ModelsConfig.vue';
import DefaultSettings from './views/config/DefaultSettings.vue';
import SkillsConfig from './views/config/SkillsConfig.vue';
import PromptsConfig from './views/config/PromptsConfig.vue';
import ExtensionsConfig from './views/config/ExtensionsConfig.vue';
import ProviderEditorView from './views/config/ProviderEditorView.vue';
import ResourceEditorView from './views/config/ResourceEditorView.vue';
import AgentEditorView from './views/agents/AgentEditorView.vue';

// Step 1: base routes（一级导航由 `components/layout/nav-tree.ts` 从 meta 读取）
const baseRoutes = [
  { path: '/', redirect: '/agents' },
  {
    path: '/agents',
    component: AgentsListView,
    meta: { navLabel: 'Agents', navOrder: 10, navIcon: 'agents' },
  },
  // Agent 创建页
  {
    path: '/agents/new',
    component: AgentEditorView,
    meta: { crumbTitle: 'New Agent' },
  },
  // Agent 查看页（只读）
  {
    path: '/agents/:id',
    component: AgentEditorView,
    meta: { crumbTitleFromParam: 'id', crumbTitle: 'Agent' },
  },
  // Agent 编辑器
  {
    path: '/agents/:id/edit',
    component: AgentEditorView,
    meta: { crumbTitleFromParam: 'id', crumbTitle: 'Edit Agent' },
  },
  {
    path: '/sessions',
    component: SessionsListView,
    meta: { navLabel: 'Sessions', navOrder: 20, navIcon: 'sessions' },
  },
  {
    path: '/sessions/:id',
    component: () => import('./views/sessions/SessionDetailView.vue'),
    meta: { crumbTitleFromParam: 'id', crumbTitle: 'Session' },
  },
  {
    path: '/sessions/:id/edit',
    component: () => import('./views/sessions/SessionDetailView.vue'),
    meta: { crumbTitleFromParam: 'id', crumbTitle: 'Edit Session' },
  },
  {
    path: '/architecture',
    component: () => import('./views/ArchitectureView.vue'),
    // mobileHidden：架构图是撑满视口的 iframe，紧凑断点下不出现在抽屉里
    meta: {
      fullWidth: true,
      mobileHidden: true,
    },
  },
  {
    path: '/im/:channelType?',
    component: ChannelsView,
    meta: { navLabel: 'IM', navOrder: 30, navIcon: 'im', fullWidth: true },
  },
  {
    path: '/config',
    component: ConfigView,
    meta: { navLabel: '配置', navOrder: 50, navIcon: 'settings', fullWidth: true },
    // 嵌套路由：ConfigView 作为模块壳（紧凑断点的分段控件），子路由填充内容。
    // `new` 子路由声明在 `:name?` 之前；vue-router 也按静态段得分优先匹配。
    children: [
      { path: '', redirect: { name: 'config-models' } },
      { path: 'models', name: 'config-models', component: ModelsConfig },
      {
        path: 'models/new',
        name: 'config-model-new',
        component: ProviderEditorView,
        meta: { crumbTitle: '新建 Provider' },
      },
      {
        path: 'models/:name/edit',
        name: 'config-model-edit',
        component: ProviderEditorView,
        meta: { crumbTitleFromParam: 'name', crumbTitle: '编辑 Provider' },
      },
      { path: 'settings', name: 'config-settings', component: DefaultSettings },
      {
        path: 'skills/new',
        name: 'config-skill-new',
        component: ResourceEditorView,
        meta: { resource: 'skills', crumbTitle: '新建 Skill' },
      },
      {
        path: 'skills/:name?',
        name: 'config-skills',
        component: SkillsConfig,
        meta: { crumbTitleFromParam: 'name' },
      },
      {
        path: 'prompts/new',
        name: 'config-prompt-new',
        component: ResourceEditorView,
        meta: { resource: 'prompts', crumbTitle: '新建 Prompt' },
      },
      {
        path: 'prompts/:name?',
        name: 'config-prompts',
        component: PromptsConfig,
        meta: { crumbTitleFromParam: 'name' },
      },
      { path: 'extensions', name: 'config-extensions', component: ExtensionsConfig },
    ],
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
