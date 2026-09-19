# pi-agent-web overview

> pi-agent-web 子项目的架构入口。

## 系统全景图

```
┌────────────────────────────────────────────────────────────────────┐
│ Vue 3 SPA (Vite)                                                  │
│                                                                    │
│ ┌─ AppShell ──────────────────────────────────────────────────────┐ │
│ │ [☰] 面包屑 / 配置 / Skills / my-skill     [架构图] [主题]     │ │
│ ├─────────────────────────────────────────────────────────────────┤ │
│ │ ┌──────────┬──────────────────────────────────────────────────┐ │ │
│ │ │ AppDrawer│  main / <router-view>                            │ │ │
│ │ │ (汉堡    │                                                  │ │ │
│ │ │  + 1/2级 │  AgentsListView / SessionsListView / ConfigView  │ │ │
│ │ │  导航)   │  / ChannelsView / ChatView / ...                │ │ │
│ │ └──────────┴──────────────────────────────────────────────────┘ │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                         │ fetch / SSE                              │
│                         ▼                                          │
│              pi-agent-server (master + worker pool)                │
└────────────────────────────────────────────────────────────────────┘
```

## 核心思想

pi-agent-web 是一个 Vue 3 SPA（Vite 构建），**不引入重型组件库**，**自写业务组件**，样式用全局 CSS 变量 + scoped style。

- **导航**：汉堡抽屉 + 面包屑（桌面/手机统一形态），数据驱动（`meta.navLabel` / `navOrder`）
- **路由**：嵌套路由（`/config` 壳 + 子路由），路由参数驱动 section 选择，替代本地 ref
- **弹框**：内容型弹框→路由页（获得深链/返回键/刷新不丢），全局确认→`ConfirmDialogHost`
- **响应式**：`useMediaQuery` composable 条件渲染（非纯 CSS 隐藏），断点 768px / 1024px
- **布局原语**：`SplitPane` / `ListEditor` / `EditorPage` 三个复用组件
- **亮暗主题**：CSS variables + `useTheme` + `<html data-theme="...">`
- **渠道包集成**：`import.meta.glob` 动态发现 → `useChannelList` 共享清单 → 渲染 channel admin 组件

## 技术栈

| 维度 | 选择 |
|---|---|
| 框架 | **Vue 3**（`<script setup>` + `ref` / `computed` / `watch`） |
| 构建 | **Vite**（`@vitejs/plugin-vue` + `@tailwindcss/vite`） |
| 样式 | 全局 CSS 变量（`--bg` / `--surface` / `--accent` 等）+ scoped style |
| 状态管理 | **Pinia**（已装，0 store；状态用 view 本地 `ref()`） |
| 路由 | **Vue Router**（嵌套路由 + `meta.navLabel` 数据驱动） |
| HTTP | `fetch`（浏览器原生） |
| SSE | `EventSource`（浏览器原生，封装为 `useSSE`） |
| 类型 | **TypeScript strict** |

**不引入**：重组件库 / shadcn-vue / Nuxt / SSR / 单元测试 / i18n。

## 页面结构

```
src/views/
├── AgentsListView.vue           /agents（列表）
├── SessionsListView.vue         /sessions（列表）
├── ChatView.vue                 /chat/:id（聊天页，独立于 AppShell）
├── ArchitectureView.vue         /architecture（iframe，mobileHidden）
├── agents/
│   └── AgentEditorView.vue      /agents/new | /agents/:id/edit
├── config/
│   ├── ConfigView.vue           /config（嵌套路由壳 + 紧凑 chip 行）
│   ├── sections.ts              section 定义（单一事实来源）
│   ├── ModelsConfig.vue         /config/models
│   ├── ProviderEditorView.vue   /config/models/new | :name/edit
│   ├── DefaultSettings.vue      /config/settings
│   ├── SkillsConfig.vue         /config/skills/:name?（ListEditor 包装）
│   ├── ResourceEditorView.vue   /config/skills/new | /config/prompts/new
│   ├── PromptsConfig.vue        /config/prompts/:name?（ListEditor 包装）
│   ├── ExtensionsConfig.vue     /config/extensions
│   └── models-api.ts            models 类型/读写/校验
└── im/
    └── ChannelsView.vue         /im/:channelType?（路由参数驱动 + chip 行）
```

### 路由表（`main.ts`）

```
/                                    redirect → /agents
/agents                              AgentsListView
/agents/new                          AgentEditorView
/agents/:id/edit                     AgentEditorView
/sessions                            SessionsListView
/chat/:id                            ChatView（独立，不套 AppShell）
/im/:channelType?                    ChannelsView
/architecture                        ArchitectureView（mobileHidden）
/config                              ConfigView（嵌套壳）
  /config                            → redirect config-models
  /config/models                     ModelsConfig
  /config/models/new                 ProviderEditorView
  /config/models/:name/edit          ProviderEditorView
  /config/settings                   DefaultSettings
  /config/skills/:name?              SkillsConfig
  /config/skills/new                 ResourceEditorView
  /config/prompts/:name?             PromptsConfig
  /config/prompts/new                ResourceEditorView
  /config/extensions                 ExtensionsConfig
```

面包屑由路由 `meta.crumbTitle` / `meta.crumbTitleFromParam` 补充最后一段（`/config/skills/my-skill` → 配置 / Skills / my-skill）。

## 组件结构

### 导航与外壳

```
src/components/layout/
├── AppShell.vue          顶层外壳：header + body（drawer + main）
├── AppDrawer.vue         汉堡抽屉（1 级/2 级菜单，>4 项折叠「更多」）
├── AppBreadcrumb.vue     面包屑（路由层级真实反映）
└── nav-tree.ts           导航树推导（router.getRoutes() → 静态前缀 → children）
```

**抽屉行为**（`design.md D2`）：
- `≥1024px`：常驻侧栏（flex sibling，挤压内容）
- `<1024px`：`position: fixed` overlay + 背板遮罩，Esc/点遮罩/选中后关闭
- 默认完全收起（`localStorage` 持久化桌面展开状态）

**断点契约**（`design.md D4`）：

| 断点 | 布局 |
|---|---|
| `< 768px` | 紧凑：单栏，section chip 行，原生 select |
| `768 – 1023px` | 中等：表单可两列，抽屉仍为 overlay |
| `≥ 1024px` | 桌面：抽屉为侧栏，内容可两栏 |

### 布局原语

```
src/components/layout/primitives/
├── SplitPane.vue        桌面两栏 ↔ 紧凑单栏下钻（v-show + display:none）
├── ListEditor.vue       列表+内容编辑+删除（Skills/Prompts 共用）
└── EditorPage.vue       编辑器路由页外壳（返回/取消/保存/底部操作栏）
```

| 原语 | 用途 | 桌面 | 手机 |
|---|---|---|---|
| `SplitPane` | Skills/Prompts 列表→详情 | 左右两栏 | 单栏 + 返回条 |
| `ListEditor` | 通用列表+内容编辑 | 列表240px + 内容 | 堆叠，内容只读 |
| `EditorPage` | Provider/Agent 编辑器 | 居中最大宽度 | 全宽，底部操作栏 sticky |

### UI 组件

```
src/components/ui/
└── AppIcon.vue       共享 SVG icon（agents/sessions/menu/close/chevron 等 30+）
```

### Composables

```
src/composables/
├── useTheme.ts        亮暗主题 + localStorage + meta theme-color
├── useSSE.ts          EventSource 封装 + 指数退避重连（1s→30s）+ 类型化事件
├── useMediaQuery.ts   window.matchMedia 响应式封装 + BP 断点常量
└── useFeedback.ts     toast / confirmDialog / confirmDelete（复用 AppShell 的 host）
```

**`useMediaQuery` 关键点**：
- 首帧同步（`matchMedia().matches`），无布局跳动
- `onUnmounted` 自动清理 listener
- `useIsCompact()` / `useIsDesktop()` 快捷方法
- **条件渲染，非 CSS 隐藏**：避免双滚动容器 / 双 textarea 可聚焦

### 渠道包集成

```
src/modules/im-gateway/
├── index.ts              glob 发现 channel admin pages + loadChannelManifest()
├── useChannelList.ts     共享渠道清单（module-level 缓存 + 单次在途请求）
├── components/
│   ├── ToastHost.vue     全局 toast（im-gateway:toast 事件驱动）
│   ├── ConfirmDialogHost.vue  全局确认弹框（im-gateway:confirm 事件驱动）
│   └── ApiFetchProvider.vue   渠道 API 代理（prefix /api/im/<type>）
└── channel-admin.ts      类型导出 + provide/inject
```

**渠道包契约**（`packages/channel-types` 定义）：
- `ChannelAdminHost`：`apiFetch` / `showToast` / `showConfirmDialog` / `useI18n`
- `ChannelAdminPage`：`channelType` + `displayName` + `component`
- 渠道包通过 `import.meta.glob('../../../../channels/*/src/admin/index.ts')` 被发现
- 本次重构**未改动** `ChannelAdminHost` 签名（5.11 已验证）

## 响应式策略

### 规则

1. **条件渲染，不靠 CSS 隐藏**：`isCompact` 控制 `v-if` / `v-show`，避免双滚动容器
2. **断点驱动路由参数**：`/config/:section?` 在任何断点都能工作
3. **原生替代自定义**：紧凑断点下 agent 筛选从自定义下拉换为原生 `<select>`（触摸体验更好）
4. **iOS 防缩放**：所有 `<input>` / `<select>` / `<textarea>` 的 font-size 在紧凑断点保持 ≥16px

### 紧凑断点的差异化表现

| 元素 | 桌面 | 紧凑 |
|---|---|---|
| 顶栏 | 46px 高，品牌+面包屑+actions | 同，品牌文字隐藏 |
| 抽屉 | 常驻侧栏 | overlay + 遮罩 |
| section 切换 | 抽屉二级菜单 | 顶部分段 chip 行（可滚动） |
| Agent 筛选 | 自定义搜索下拉 | 原生 `<select>` |
| Skills 列表 | 两栏 SplitPane | 单栏 + 返回条 |
| Skills 内容 | textarea 可编辑 | 只读 + 桌面编辑提示 |
| Extensions 上传 | URL + 文件上传 | URL + 单文件（隐藏 zip） |
| Provider 编辑器 | 表单/JSON 双模式 | 强制 JSON 模式 |
| 二维码弹框 | 居中 dialog | 全屏 + 二维码放大 |

## 关键设计点

### 1. 导航树推导（`nav-tree.ts`）

一级项从 `router.getRoutes()` 的 `meta.navLabel` 自动推导——加路由就出现导航，不需要配置文件。二级项由 `nav-tree.ts` 按路径匹配：
- `/config` → `CONFIG_SECTIONS`（来自 `sections.ts`）
- `/im` → `useChannelList()`（manifest 动态发现）

路由含参数时（`/config/:section?`），用 `navPathOf()` 取**参数前的静态前缀**作为导航路径，避免含 `:` 的路由被排除。

### 2. 路由参数驱动 section 选择

`ConfigView` 通过 `configSectionFromPath(route.path)` 从路由路径解析当前 section（`/config/skills/my-skill` → `skills`），不再维护本地 `activeTab` ref。好处：可深链、浏览器返回键可用、刷新不丢。

### 3. 渠道清单共享（`useChannelList.ts`）

模块级缓存（`let cached`）+ 单次在途请求（`let inflight`），避免 `AppDrawer` 和 `ChannelsView` 同时加载时发两次 manifest fetch。首次渲染后数据复用。

### 4. 反馈统一（`useFeedback.ts`）

全站 `alert()` / `confirm()` 替换为 `toast()` / `confirmDialog()`，通过 `CustomEvent` 派发到已挂载于 `AppShell` 的 `ToastHost` / `ConfirmDialogHost`。**ChatView 不在 AppShell 内，因此保留其 `confirm()`**（out of scope）。

### 5. 主题切换

```typescript
// useTheme.ts
function useTheme() {
  const theme = ref<'light' | 'dark'>(
    localStorage.getItem('theme') as any ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );
  function toggle() { ... }
  return { theme, toggle };
}
```

### 6. 渠道 admin 暗色

`QqChannelsPage.vue` / `WechatChannelsPage.vue` / `QrLoginDialog.vue` × 2 的 115 处字面量色值已全部替换为 CSS 变量（`--surface` / `--border` / `--accent` 等），仅保留 accent 按钮上的 `#fff` 文字和 overlay 基色。

## 渠道 admin 页面（`channels/*/src/admin/`）

这些文件**渲染在 web 端**但**源码在 `channels/`**，属于渠道包前端部分。本次改动范围：
- ✅ `QqChannelsPage.vue`：23 处色值→变量 + 紧凑断点
- ✅ `WechatChannelsPage.vue`：24 处色值→变量 + 紧凑断点
- ✅ `QrLoginDialog.vue` × 2：34 处色值→变量 + 紧凑全屏
- ❌ 不触碰 `channels/*/src/index.ts`（渠道后端 adapter）
- ❌ 不触碰 `packages/channel-types`（host 契约）

## 相关文档

- [`pi-agent-server_overview.md`](pi-agent-server_overview.md) —— server 端架构
- [`pi-agent-server_http-api.md`](pi-agent-server_http-api.md) —— HTTP API 路由
- [`pi-agent-server_im-gateway.md`](pi-agent-server_im-gateway.md) —— IM 渠道包（后端+前端一体化）
- `openspec/changes/responsive-web-layout/` —— 本次重构的完整设计文档（proposal/design/tasks/specs）
