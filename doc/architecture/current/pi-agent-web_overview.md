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
  /config/mcp                        McpServersView（MCP 目录维护）
  /config/skills/:name?              SkillsConfig
  /config/skills/new                 ResourceEditorView
  /config/prompts/:name?             PromptsConfig
  /config/prompts/new                ResourceEditorView
  /config/extensions                 ExtensionsConfig
  /config/templates                  TemplatesView（Agent模板）
```

面包屑由路由 `meta.crumbTitle` / `meta.crumbTitleFromParam` 补充最后一段（`/config/skills/my-skill` → 配置 / Skills / my-skill）。

**MCP 目录维护页（`platform-mcp-catalog`）**：`/config/mcp`（二级菜单「MCP」，`CONFIG_SECTIONS` 增补）→ `views/config/McpServersView.vue`。展示目录文件路径 + 每个 server 的卡片（名字 / exposure 徽标 / pi 同名冲突标记 / 停用标记 / command 或 url / 工具命名空间前缀），支持**新增、编辑（含改名）、删除**；编辑器分 stdio（command / args / env）与 http（url / headers）两种形态，env 与 headers 用「每行 `KEY=VALUE`」文本框。保存时**保留平台不建模的字段**（`timeout`、其它私有键、顶层 `autoEnableCodemode`），因为文件是 pi 的形状；写入走「临时文件 + rename」避免半截 JSON。改完调 `invalidateMcpCatalog()`，三处勾选面板下次读取即刷新。已运行的 worker 不热加载，提示「保存后新开会话才生效」。

### 内置工具清单与 MCP 开关（三处共用一份定义）

`src/constants/builtin-tools.ts` 是唯一事实源，被两处复用：`views/agents/AgentEditorView.vue`（agent 级）与 `views/sessions/SessionDetailView.vue`（会话覆盖）；`BASE_AGENT_CONFIG` 是新建 agent 表单的起点。

- **单层显式清单**：三处编辑面都没有「使用默认 / 跟随全局」复选框——打开就是生效值，不勾 = 不给。默认设置页只剩三项（默认模型 / 默认思考等级 / 启用的模型），**不再有资源默认值**。
- **清单 = 8 个纯工具 + `codemode` + `tool_search`**（共 10 项，各自带 hint 说明副作用）。`mcp` **不在清单**。
- **MCP 是独立区块**：三处共用 `components/config/McpSelectionGroup.vue`（单一实现，样式靠 scoped 保证三处一致）——一个总开关 + 平台目录 server 勾选，写 `config.mcp = { enabled, servers }`；缺失按 `{enabled:false, servers:[]}` 归一。
- **server 列表来自平台目录**：`GET /api/config/mcp-servers`（`composables/useMcpCatalog.ts`，模块级缓存一次）。目录里已不存在的勾选值渲染黄标幽灵项 + 「清理无效项」；目录解析错误与 pi 同名冲突在区块下方提示（pi 优先，平台开关对它们无效）。
- **关闭即清空**：关掉总开关会同时把 `servers` 清空（开关就是生效条件，保留无效选择会让人误以为还在连）；关掉 MCP **不**回滚 `codemode` / `tool_search`。
- **依赖联动**：打开 MCP 时 `withMcpDependencies()` 把 `codemode` / `tool_search` 补进 `builtinTools`（`MCP_DEPENDENT_TOOLS`，与 worker 侧同名规则）；加载时若 `mcp.enabled` 也已补齐，避免「显示未勾、实际生效」；关掉 MCP **不**回滚这两项。
- **每个资源分组带「全选 / 清空」**；全选 = **展开成当前所有项的显式清单**（不存 `*` 特例），页面文案提示"后续新增资源不会自动加入"。
- **无效项标注**：`composables/useConfigIssues.ts` 基于 `GET /api/config/{extensions,skills,prompts,capabilities}` 与模型列表计算，列表里的失效值渲染黄标 + 原因 tooltip +「清理无效项」；保存响应里的 `issues[]` 同步汇总到顶部横幅；`capabilities === null` 不标注，模型不可用只标不自动替换。

**Agent模板（`agent-templates`）**：`/config/templates`（配置模块二级菜单「Agent模板」，`views/config/sections.ts` 的 `CONFIG_SECTIONS` 增补）管理页 `views/templates/TemplatesView.vue`——**卡片网格**展示（名称 / 描述 / 分项标签 `templateFacets()` / 更新时间 / 编辑·删除），支持**页内新增模板**（从零勾选七项）与**编辑**（名称 + 描述 + `TemplateResourceForm` 七分组勾选，编辑卡片占满整行）；agent / session 编辑页 Resources 区的「从模板填充 / 存为模板」工具条共用 `composables/useTemplates.ts`。模板 = 七字段快照（`systemPrompt` 不入模板）；填充先 `confirmDialog` 确认，只改表单本地状态（不保存退出即恢复，无来源标记、无撤销按钮），填充时 `systemPrompt` 清空、MCP 依赖自动补齐。

**页面说明统一走 `InfoTip`**（`components/ui/InfoTip.vue`）：标题 / 分组标题旁一个 `i` 图标，点击弹气泡（Esc 或点空白关闭），不再在页面里堆内联长文案。配置类页面（agent 编辑、session 编辑、默认设置、模板编辑器、Agent模板页）均已迁移。

**资源区默认铺开**：agent / session 编辑页的 Resources（含 Capabilities）不再折叠，进页面即可见全部清单（原先的 `resourcesExpanded` 开关已移除）。

会话信息面板（`components/chat/SessionInfoModal.vue`，IDE 端 `apps/pi-agent-ide/src/components/SessionInfoModal.vue` 同构）按 `resources` 分区渲染：SKILLS / EXTENSIONS / TOOLS / **MCP**。MCP 区按 server 分组（`mcpServers`，工具多时默认收起，标题显示 `<server> N 工具（M 未加载）`）；TOOLS 区不出现 `mcp__*`，badge 语义：`builtin`（pi 核心工具与 codemode/tool_search）、扩展名（`mcp` / `npm:xxx`）、`platform`（worker 注册的 `sendFileToUser` 等）。`deferred` / `hidden` 工具默认折叠，可展开。

### 对话页布局 v3（`session-streaming-runtime`）

单会话单页、**桌面优先**（移动端不投入，未来由 App 接管）：

```
┌─────────────────────────────────────────────────────┐
│ 状态栏（整页宽、左右贴边；标题左、连接点/关闭右）          │ 48px
├─────────────────────────────────────────────────────┤
│                        ┌ 860px 内容列 ┐      ▏轨道   │
│                        │ 消息流（滚动）│      ▏☰ 运行 │
│                        │──────────────│      ▏◔ 上下文│
│                        │ SteerSubBar  │      ▏ⓘ 信息 │
│                        │ InputBox     │      ▏      │
│                        └──────────────┘      ▏      │
└─────────────────────────────────────────────────────┘
```

- **状态栏不受内容列约束**：`.chat-header` 横跨整页，内部 `.header-inner` **无 max-width**，元素贴左右边（原先误用 860 居中，会让标题不贴左、关闭钮不贴右）。
- **内容列 860px**：`.messages-column` / `.chat-footer` / 抽屉槽三者对齐；输入框**停靠**在消息流底部（不是固定到视口底）。
- **右侧 icon 轨道**（`.chat-rail`，`ChatView.vue` 内联）：绝对定位 `right:6px`、起始于状态栏下方、`opacity:.38`（非激活半透明）、hover 或展开时为 1；三个入口 = 运行状态 / 上下文 / 会话信息。
- **抽屉**（`.chat-drawer`，同上内联）：默认 380px、`right:44px`（给轨道留槽）、覆盖在内容上方（**不挤压 860 读宽**）；`z-index` 轨道 30 > 抽屉 20，所以抽屉打开时仍能切 tab；关闭靠抽屉 ✕ 或再点同一轨道钮（不做遮罩：遮罩会盖住正文）。
- **抽屉宽度可拖拽**：左边缘 6px `.drawer-resize` 手柄（`col-resize`），范围 280–760px，松手后写入 `localStorage['pi-agent:chat-drawer-width']`。
- **会话信息在抽屉内渲染**（不再是 modal）：`SessionInfoModal.vue` 支持 `embedded` 属性——`embedded` 时只输出滚动内容，外壳/关闭钮/宽度由抽屉提供。
- **运行态权威源**：`composables/useSessionRun.ts` + SSE `session_snapshot` / `agent_start` / `agent_settled` / `session_disposed`，`isRunning = run.running || sending`（`sending` 只是乐观 UI）。刷新页面即从快照恢复「停止」按钮与 typing 指示。

### 工具卡片（`components/chat/tool-blocks/`）

- 注册表 `registry.ts#resolveToolBlock(name)` → **按工具名**绑定卡片组件（`read`→ReadCard、`edit`→EditCard、`bash`/`shell`/`powershell`→BashCard、`grep`/`find`/`ls`→SearchCard、`write`→WriteCard、`fetch`/`web_*`→FetchCard）；无专用卡的回落 `DefaultCard`。**没有 kind 分类**——分类只对一方工具可知，三方工具和未来的用户脚本都只能按名字匹配（`mcp__*` 按前缀规则走 `DefaultCard`，名字原样展示，不拆命名空间）。
- 共享卡壳 `ToolCard.vue` 负责：图标 + 工具名（mono）+ 单行摘要 + 耗时 + 状态胶囊；失败默认展开、流式强制展开、结算自动收起、手动开关 pinned；拖拽选择文字不触发折叠；工具返回的图片统一在卡下方渲染。
- 卡片外观按原型：头部 `--surface-hover` 底 + 胶囊状态（`ok`/`bad`/`run`），正文 mono 12px 最高 340px 滚动，页脚 11.5px 细线分隔。
- **各卡 body 不同**（这也是"按名分派"的意义）：`BashCard` 终端风（`$` 提示行 + 输出区 + 流式块光标）；`ReadCard` 行号行槽（pi 已自带行号时不自加，`[N more lines …]` 提示单独成行不占行号）；`SearchCard` 将 `path:line:snippet` 拆为文件/行号/片段三列；`EditCard` 统一 diff（`-` 红 / `+` 绿）并汇总 `-n +n`；`WriteCard` 新内容整段标绿；`FetchCard` = url + 文本输出；`DefaultCard` = 参数 + 结果原文。
- 用量：`InputBox` 的 `.usage-chip` 展示最近一条 assistant 消息的 `usage`（`85↑ 17↓ · 16.9k cache`），历史回放无该字段→不显示。

### 历史分页（`session-streaming-runtime`）

`useSSE` 每次 `HISTORY_PAGE_SIZE=50` 拉最后一页（`?limit=`），滚到顶部（<120px）触发 `loadOlder()`（`?before=nextBefore`）；`MessageList` 用「scrollHeight/scrollTop 锚点」在 prepend 后复原阅读位置，顶部提示 `Loading earlier messages…` / `Scroll up to load earlier messages`。服务端分页契约见 [pi-agent-server_http-api.md](pi-agent-server_http-api.md)。

### Mermaid 与 Markdown 渲染（`components/chat/MarkdownView.vue` + `composables/useMermaid.ts`）

- **主题从 CSS 变量推导，不写死颜色**：`readTheme()` 读 `--bg-primary` / `--text-primary` / `--bg-secondary` / `--border`，派生出 mermaid 的 `surface0/1/2`、`text`、`subtext`、`line`、`accent`、`muted` 后写进 `themeVariables`；`data-mode` 变化即对全部图重新 `render`（切主题不用刷新），配色永远跟着界面走。
- **`flowchart.htmlLabels: false`**：用 SVG `<text>` 而不是 `foreignObject`。JCEF / 离线环境下 `htmlLabels` 内部的 `<div>` 会把节点撑宽，导致布局和连线错位。
- **`vector-effect: non-scaling-stroke`**（对所有 svg 图形元素）：缩放后 1px 连接线不会因亚像素而消失——这是「线不见了」最常见的真因。
- **`.mermaid-canvas` 是无限画布**，不是缩放适配：图保持 intrinsic size，只用一个 `translate3d() scale()` 组合变换（高度按拟合尺寸写内联）。滚轮缩放 0.2–4（以光标为锚点）、拖拽平移、双击复位、点击激活（未激活时滚轮交还页面滚动）；`MessageList` 自己的滚轮劫持已加 `if (e.defaultPrevented) return` 守卫，否则一次滚轮会同时缩放图和滚列表。
- **流式期间显示源码**：fence 未闭合时渲染 `<pre class="mermaid-src">`（可选中复制），闭合后才调 mermaid；状态由 `data-mermaid-state` 表达（`waiting` / `pending` / `rendering` / `ready` / `error`）。半截代码反复 render 会闪烁并报错。
- **放大**：`Teleport` 到 body 的全屏面板，同样是无限画布（拖拽 + 滚轮 + 双指捏合），彻底不再有滚动条。
- **Markdown 其余部分**：表格加边框 + 斑马纹、hljs token 颜色全部走主题变量、代码块用专用 `--code-bg`（不跟随正文 hover 色）。
- **IDE SPA 是同一实现的副本**：`apps/pi-agent-ide/src/composables/useMermaid.ts` + `components/MarkdownView.vue` 里的 `.mermaid-*` 样式块，差异只有 CSS 变量（IDE 侧用 `--bg-primary` / `--text-primary` / `--border` / `--link`）。改 web 侧渲染逻辑时**必须同步 ide 侧**——历史上「web 修了 ide 没修」已经出现两次（工具滚轮、历史分页）。

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
- OpenSpec change `responsive-web-layout`（本地工作流产物，不引用路径）—— 本次重构的完整设计文档（proposal/design/tasks/specs）
