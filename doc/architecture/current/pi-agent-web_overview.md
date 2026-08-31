# pi-agent-web overview

> pi-agent-web 子项目的架构入口。

## 系统全景图

```
┌──────────────────────────────────────────────────────────┐
│ Vue 3 SPA (Vite) │
│ │ │
│ ┌──────┐ ┌──────────────────────────────────────────┐ │
│ │ Sidebar│ │ ChatWindow │ │
│ │ (sess) │ │ (消息列表 + 自动滚动)│ │
│ │ mobile│ │ │ │
│ │ Bottom│ │ ChatInput │ │
│ │ Nav │ │ (textarea + 自动高度) │ │
│ └──────┘ └──────────────────────────────────────────┘ │
│ │ ▲ │ │
│ │ SSE / fetch │ │
│ ▼ │ │
│ PiSessionProxy ──────────────────────────────→ Server │
└──────────────────────────────────────────────────────────┘
            │
            ▼
   pi-agent-server (master + worker pool)
```

## 核心思想

pi-agent-web 是一个 Vue 3 SPA（Vite 构建）。**不引入重型组件库**（naive-ui / Ant Design / Element Plus），**自写业务组件**，样式用 Tailwind CSS v4 原子化 class。

- **流式响应**：自封装 `useSSE` composable（EventSource + 重连 + 中断）
- **chat 原语**：自写 `ChatWindow` / `ChatInput` / `ChatMessage` 等业务组件
- **响应式**：CSS 媒体查询 + `useIsMobile` composable，移动端用抽屉 / Bottom nav
- **亮暗主题**：CSS variables + `useTheme` composable + `<html data-theme="...">`
- **不引入测试**（v1）：等主体稳了再补

## 技术栈

| 维度 | 选择 | 理由 |
|---|---|---|
| 框架 | **Vue 3**（~16KB）| 复用旧 web 经验 / 轻量 |
| 构建 | **Vite** | 快 / 现代 / Vue 官方推荐 |
| 样式 | **Tailwind CSS v4**（`@tailwindcss/vite`）| 主流 / 原子化 / AI 友好度最高 |
| 状态管理 | **Pinia** | Vue 3 推荐 / 轻量 |
| 路由 | **Vue Router** | Vue 生态标准 |
| HTTP | **fetch**（浏览器原生）| 简单 |
| SSE | **EventSource**（浏览器原生）| 简单 |
| 类型 | **TypeScript strict** | 一致性 |

**不引入**（v1）：
- ❌ 重组件库（naive-ui / Ant Design / Element Plus）
- ❌ shadcn-vue（生态不成熟）
- ❌ assistant-ui-vue（auto-maintained repo，不稳定）
- ❌ Nuxt / Next.js（SSR 不需要）
- ❌ 单元测试（v1 跳过，等主体稳了补）
- ❌ i18n 库（v1 不做）

## 页面结构

```
src/views/
├── AgentsListView.vue         # /agents
├── AgentCreateView.vue        # /agents/create
├── AgentDetailView.vue        # /agents/:id（编辑 + session列表）
├── SessionsListView.vue       # /sessions
├── SessionDetailView.vue      # /sessions/:id（聊天页，核心）
└── SettingsView.vue           # /settings
```

## 组件结构

### 业务组件（自写，~15 个）

```
src/components/
├── layout/
│   ├── AppShell.vue          # 响应式布局（侧栏 / Bottom nav）
│   ├── Sidebar.vue          # 桌面 session 侧栏
│   ├── BottomNav.vue        # 移动底部导航
│   └── TopBar.vue           # logo + actions + theme toggle
├── chat/
│   ├── ChatWindow.vue       # 消息列表 + 自动滚动
│   ├── ChatMessage.vue      # 单消息（user / assistant / tool）
│   ├── ChatInput.vue        # 输入框 + 自动高度
│   ├── ToolCallCard.vue     # 工具调用折叠卡
│   └── ModelSelector.vue    # 模型下拉
├── agent/
│   ├── AgentCard.vue        # agent 卡片
│   └── AgentForm.vue        # agent 编辑表单
├── session/
│   └── SessionListItem.vue  # session 列表项
└── ui/
    ├── ThemeToggle.vue      # 亮暗主题切换按钮
    └── EmptyState.vue       # 空状态占位
```

### Composables（~5 个）

```
src/composables/
├── useTheme.ts              # 亮暗主题 + localStorage
├── useSSE.ts                # EventSource 封装 + 重连 + 中断
├── useSession.ts            # session 操作（CRUD + 占位 + prompt）
├── useAgent.ts              # agent 操作（CRUD）
└── useIsMobile.ts           # 响应式检测（matchMedia）
```

### Pinia stores（~3 个）

```
src/stores/
├── agents.ts                # agent 列表 + 当前 agent
├── session.ts               # 当前 session + messages + 流式状态
└── ui.ts                    # theme / sidebar / modal 等 UI 状态
```

## 核心：聊天页（SessionDetailView）

### 功能清单

**消息渲染**：
- 用户消息（右侧气泡）
- Assistant 消息（左侧，带工具调用折叠卡）
- 流式响应（打字机效果）
- 错误消息（**按架构决策：作为 chat 消息展示，不弹 toast**）

**交互**：
- 输入框：textarea + 自动高度 + Enter 发送 / Shift+Enter 换行
- 模型切换（下拉）
- thinking level 切换
- abort 中断（流式时显示停止按钮）
- session 切换（侧栏 / Bottom nav）

### 状态机

```
[空闲]
  ↓ 用户输入 + 调 prompt API
[等待响应]
  ↓ master 调 worker + createAgentSession + session.prompt
[流式接收中]
  ↓ SSE event: message_update → 更新 messages ref
[流式接收中]...
  ↓ SSE event: agent_end → 清掉流式状态
[完成]
```

**abort 流程**：
- 流式中点停止 → 调 `POST /api/sessions/:id/abort`
- master 通过 IPC 通知 worker 调 `session.abort()`
- worker 通过 SSE event 推 `abort` 给前端
- client 清掉流式状态

## 关键设计点

### 1. 自动滚动

```typescript
// ChatWindow.vue
function scrollToBottom() {
  // 仅在用户没滚上去时自动滚
  if (isNearBottom.value) {
    containerRef.value?.scrollTo({
      top: containerRef.value.scrollHeight,
      behavior: 'smooth',
    });
  }
}
watch(messages, scrollToBottom, { deep: true });
```

### 2. SSE 重连

```typescript
// useSSE.ts
function createSSE(sessionId: string) {
  let es: EventSource | null = null;
  let retryDelay = 1000;

  function connect() {
    es = new EventSource(`/api/sessions/${sessionId}/events`);
    es.onerror = () => {
      es?.close();
      // 指数退避重连
      setTimeout(() => {
        retryDelay = Math.min(retryDelay * 2, 30000);
        connect();
      }, retryDelay);
    };
  }

  function disconnect() {
    es?.close();
    es = null;
  }

  return { connect, disconnect };
}
```

### 3. 主题切换

```typescript
// useTheme.ts
function useTheme() {
  const theme = ref<'light' | 'dark'>(
    localStorage.getItem('theme') as any ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );

  function toggle() {
    theme.value = theme.value === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme.value;
    localStorage.setItem('theme', theme.value);
  }

  watch(theme, (t) => {
    document.documentElement.dataset.theme = t;
  }, { immediate: true });

  return { theme, toggle };
}
```

### 4. 响应式（mobile vs desktop）

```css
/* 桌面：左侧栏 + 聊天 */
.app-shell { display: grid; grid-template-columns: 240px 1fr; }

/* 移动：底部 nav + 聊天 */
@media (max-width: 768px) {
  .app-shell { display: grid; grid-template-rows: 1fr auto; }
  .sidebar { display: none; } /* 移动端用抽屉触发 */
}
```

## 需要补充的 API（之前没在 http-api.md 里）

| 端点 | 方法 | 用途 | sessionId 来源 |
|---|---|---|---|
| `/api/sessions/:id/messages` | GET | **历史消息列表**（首次加载）| URL |

**为什么需要**：聊天页打开（archived session 恢复），要拉历史消息。

**实现**：master 通过 IPC 让 worker 从 `~/.pi/agent/sessions/<id>/` 读 pi SDK 的 session 文件，转换成 API 返回。

## 待决项

| 项 | 状态 |
|---|---|
| **附件上传**（图片 / 文件）| 🟢 v1 不做 |
| **代码高亮**（highlight.js / shiki）| 🟢 v1 不做 |
| **Markdown 渲染**（marked / markdown-it）| 🟢 v1 不做 |
| **单元测试**（vitest）| 🟢 v1 不做，主体稳了补 |
| **i18n** | 🟢 v1 不做（先支持中英）|
| **历史消息加载 API**（`GET /api/sessions/:id/messages`）| 🟡 未讨论（已识别需要）|
| **session 列表 / 详情接口** | 🟢 已有 |

## 相关文档

- [`pi-agent-server_overview.md`](pi-agent-server_overview.md) —— server 端架构
- [`pi-agent-server_http-api.md`](pi-agent-server_http-api.md) —— HTTP API 路由

## 参考

- [`reference/projects/pi-web-main/`](../../reference/projects/pi-web-main/) —— 独立的 pi Web 端（UI 参考）
- [`reference/projects/craft-agents-oss-main/apps/webui/`](../../reference/projects/craft-agents-oss-main/apps/webui/) —— 第三方 agent UI 套件（参考）
- [`reference/projects/personal-agent-manage/agent-manage-web/`](../../reference/projects/personal-agent-manage/agent-manage-web/) —— 旧 web（Vue 3）