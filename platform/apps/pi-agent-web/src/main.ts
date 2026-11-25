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

import ConfigView from './views/config/ConfigView.vue';
import ModelsConfig from './views/config/ModelsConfig.vue';
import DefaultSettings from './views/config/DefaultSettings.vue';
import McpServersView from './views/config/McpServersView.vue';
import PluginsView from './views/config/PluginsView.vue';
import SkillsConfig from './views/config/SkillsConfig.vue';
import PromptsConfig from './views/config/PromptsConfig.vue';
import ExtensionsConfig from './views/config/ExtensionsConfig.vue';
import SystemLogs from './views/config/SystemLogs.vue';
import ProviderEditorView from './views/config/ProviderEditorView.vue';
import ResourceEditorView from './views/config/ResourceEditorView.vue';
import AgentEditorView from './views/agents/AgentEditorView.vue';
import TemplatesView from './views/templates/TemplatesView.vue';
import { refreshPluginPages, syncPluginRoutes } from './plugins/pages';
import { installNavigator } from './router-navigate';

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
  // 通知不进抽屉（铃铛入口），mobileHidden 避免和别人抢位置
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
        path: 'mcp',
        name: 'config-mcp',
        component: McpServersView,
        meta: { crumbTitle: 'MCP' },
      },
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
      {
        path: 'plugins',
        name: 'config-plugins',
        component: PluginsView,
        meta: { crumbTitle: '平台插件' },
      },
      { path: 'extensions', name: 'config-extensions', component: ExtensionsConfig },
      {
        path: 'templates',
        name: 'config-templates',
        component: TemplatesView,
        meta: { crumbTitle: 'Agent 模板' },
      },
      { path: 'logs', name: 'config-logs', component: SystemLogs },
    ],
  },

  {
    path: '/plugin-page/:pluginId/:pageId',
    name: 'plugin-page',
    component: () => import('./views/PluginPageView.vue'),
    // 插件菜单不进路由表（运行期新增不触发重算），所以入口是一条静态路由。
    meta: { fullWidth: true },
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
// 插件侧 `host.ui.navigate(path)` 的落地实现（不暴露 router 实例）
installNavigator((path) => void router.push(path));
installRouteTransitions(router);
// 插件页面（导航 + 路由）来自 server 注册表，启动时拉一次（失败就空导航，不阻塞启动）。
void refreshPluginPages().then(() => syncPluginRoutes(router));

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');

