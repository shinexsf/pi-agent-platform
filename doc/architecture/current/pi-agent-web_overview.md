# pi-agent-web overview

> pi-agent-web 子项目的架构入口。

## 系统全景图

```
┌──────────────────────────────────────────────────────────┐
│ Vue 3 SPA (Vite) │
│ │
│ ┌────────────────┐ ┌─────────────────────────────────┐ │
│ │ SessionsListView │ │ SessionDetailView │ │
│ │ (table + page) │ │ (chat inline: │ │
│ │ │ │  消息气泡 + auto-scroll │ │
│ │ │ │  + tool details collapse) │ │
│ │ │ │ │ │
│ │ │ │ (ChatInput inline) │ │
│ └────────────────┘ └─────────────────────────────────┘ │
│ │ ▲ │
│ │ SSE (useSSE) / fetch │
│ ▼ │
│ pinia (installed, 0 store) → │
│ PiSessionProxy (per-page useSSE) → Server │
└──────────────────────────────────────────────────────────┘
            │
            ▼
   pi-agent-server (master + worker pool)
```

## 核心思想

pi-agent-web 是一个 Vue 3 SPA（Vite 构建）。**不引入重型组件库**（naive-ui / Ant Design / Element Plus），**自写业务组件**，样式用 Tailwind CSS v4 原子化 class。

- **流式响应**：自封装 `useSSE` composable（EventSource + 重连 + 中断）
- **chat 原语**：MVP 不抽独立 chat 组件，全部 inline 到 `SessionDetailView.vue`（待主体稳了再拆）
- **响应式**：CSS 媒体查询为主，`window.matchMedia` 内联判断，未抽独立 composable
- **亮暗主题**：CSS variables + `useTheme` composable + `<html data-theme="...">`
- **不引入测试**（v1）：等主体稳了再补

## 技术栈

| 维度 | 选择 | 理由 |
|---|---|---|
| 框架 | **Vue 3**（~16KB）| 复用旧 web 经验 / 轻量 |
| 构建 | **Vite** | 快 / 现代 / Vue 官方推荐 |
| 样式 | **Tailwind CSS v4**（`@tailwindcss/vite`）| 主流 / 原子化 / AI 友好度最高 |
| 状态管理 | **Pinia**（已装但 MVP 0 store，状态都 inline 在 view 里）| Vue 3 推荐 / 轻量 |
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
├── AgentsListView.vue         # /agents（列表 + inline 编辑表单）
├── SessionsListView.vue       # /sessions（列表）
└── SessionDetailView.vue      # /sessions/:id（聊天页，核心）
```

> **MVP 范围**：`AgentCreateView` / `AgentDetailView` / `SettingsView` **未单独抽页面**——`AgentsListView` 内嵌 inline 编辑表单（创建 / 修改都走 inline editor）；`Agent` 配置通过 IDE 端管理，web 端只读为主。`SettingsView` 待 web 端设置项需求出现再拆。

## 组件结构

### 业务组件（自写，实际 ~2 个）

```
src/components/
├── layout/
│   └── AppShell.vue          # 响应式布局（侧栏 + 顶部 nav + theme toggle 全部 inline 在 AppShell）
└── ui/
    └── AppIcon.vue           # 共享 SVG icon family（agents / sessions / brand / send / refresh 等）
```

> **MVP 简化**：其余"业务组件"（`ChatWindow` / `ChatMessage` / `ChatInput` / `ToolCallCard` / `ModelSelector` / `Sidebar` / `BottomNav` / `TopBar` / `ThemeToggle` / `EmptyState` 等）**未独立抽取**——直接 inline 到各 view 文件里。`SessionDetailView.vue` 内联消息渲染、auto-scroll、tool call `details/pre` 折叠等；`SessionsListView.vue` / `AgentsListView.vue` 内联各自列表项的 `resource-row` / `inline-editor` 模板。
>
> **为什么**：MVP 主体未稳，**抽组件过早**会让“重构成本反而高于复用收益”。主体稳定后再考虑抽取（IDE 端 `pi-agent-ide/` 是另一套独立抽取，参考对比）。

### Composables（实际 ~2 个）

```
src/composables/
├── useTheme.ts              # 亮暗主题 + localStorage + meta theme-color
└── useSSE.ts                # EventSource 封装 + 重连（指数退避 1s→30s） + 类型化事件
```

> **MVP 简化**：`useSession` / `useAgent` / `useIsMobile` **未拆**——session / agent 操作直接写在 view 文件里用 `fetch()`；响应式判断用 CSS 媒体查询 + 少量 `window.matchMedia` 内联。

### Pinia stores（实际 0 个）

> **MVP 范围**：`Pinia` 已装（`main.ts` 调用 `app.use(createPinia())`），但**当前 0 个 `defineStore(...)` 调用**——所有状态用 view 本地 `ref()` / `reactive()` 管理。
>
> **为什么不抽 store**：MVP 多 view 共享状态需求低（agent 列表仅 `AgentsListView` 使用，sessions 列表仅 `SessionsListView` 使用），`SessionDetailView` 内的 `messages` / `sending` / `contextCache` 只在该 view 生命周期内需要。后续如果跨 view 状态同步需求出现（多 tab 同步 / 全局 toast 队列 / 未读计数等）再抽。

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
// SessionDetailView.vue（inline）
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
// composables/useSSE.ts（实际接口）
export function useSSE(url: string): SSEController {
  let es: EventSource | null = null;
  let retryDelay = 1000;
  let closed = false;

  function open() {
    if (closed) return;
    es = new EventSource(url);
    es.addEventListener('error', () => {
      es?.close();
      es = null;
      if (closed) return;
      // 指数退避重连 1s → 30s
      const delay = retryDelay;
      retryDelay = Math.min(retryDelay * 2, 30_000);
      setTimeout(open, delay);
    });
    // 各类型事件通过 dispatch 派发到 handlers
  }

  return {
    on(event, handler) { /* 订阅事件 */ },
    off(event, handler) { /* 取消订阅 */ },
    connect: open,
    disconnect() { closed = true; es?.close(); es = null; },
  };
}
```

调用侧：

```typescript
// SessionDetailView.vue
const sse = useSSE(`/api/sessions/${props.id}/events`);
sse.on('connected', () => { connected.value = true; });
sse.on('message_update', (data) => { applyDelta(data); });
sse.on('agent_end', () => { sending.value = false; });
onMounted(() => sse.connect());
onBeforeUnmount(() => sse.disconnect());
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