# pi-agent-idea 架构概览

> 子项目：pi-agent-idea
> 子模块：overview
> 状态：✅ 已写（MVP 完成）
> 最后更新：2026-08-24

## 背景与目标

`pi-agent-idea` 是 pi-agent-platform 的 **IntelliJ IDEA 客户端**，让用户在 IDE 内直接调用平台提供的 agent 能力（创建/继续 session、查看历史、流式对话、上下文注入、权限确认等）。

**核心约束**（区别于 web 端）：

- **宿主是 IDE**，不是浏览器 —— 必须能跟编辑器深度集成（拿选区、当前文件、workspace 信息、打开文件等）
- **JVM 必须参与** —— 一些 IDE 能力在 JCEF 内无法完成（PSI、Action、Tool Window 注册等），需要在 Kotlin 侧调用 IntelliJ Platform API
- **跨语言**：UI 是 Vue/TypeScript（JCEF 渲染），IDE 桥接是 Kotlin/JVM

**不做什么**：

- ❌ 不做 RPC 中枢（旧架构痛点，由 server 接管）
- ❌ 不 spawn pi 子进程（worker 由 server 管）
- ❌ 不解析流式事件缓冲（server 已处理）

## 模块结构

### 物理布局

```
pi-agent-platform/                          # 项目根
├── platform/                                # Node.js monorepo（pnpm）
│   ├── apps/
│   │   ├── pi-agent-server/                 # 已有：hono master
│   │   ├── pi-agent-web/                    # 已有：浏览器 SPA
│   │   └── pi-agent-ide/                    # ⭐ Vue 3 SPA（JCEF 用，独立技术栈）
│   ├── workers/
│   │   └── session-worker/                  # 已有
│   └── packages/
│       ├── shared-types/                    # 已有：Vue UI 复用
│       ├── api-types/                       # 已有
│       ├── ipc-protocol/                    # 已有
│       └── sdk-integration/                 # 已有
└── pi-agent-idea/                           # ⭐ IntelliJ 插件（Kotlin + Gradle）
```

### 两个模块的职责边界

| 模块 | 技术栈 | 职责 | 不做 |
|---|---|---|---|
| **pi-agent-ide** | Vue 3 + Vite | JCEF 内渲染的聊天 UI：消息流、输入框、SSE 消费、自动滚动等 | 不管 agents/sessions 列表（外部 Swing 提供）、不管 IDE 集成（桥接调用即可） |
| **pi-agent-idea**（Kotlin）| IntelliJ Platform + Gradle | Tool Window 注册、Swing 标签页（Agents/Sessions/Settings/Chat）、IDE bridge 实现（invoke 路由表）、JCEF 集成、JBCefJSQuery 注入 | 不写业务组件（前端）、不调 HTTP API（委托给 Vue 端）|

**依赖关系**：

```
pi-agent-idea (Kotlin)
  ├─→ 加载 platform/apps/pi-agent-ide/dist/*  ← server 托管的静态资源
  │     （JCEF 访问 http://localhost:<port>/ide/）
  ├─→ 读 platform/apps/pi-agent-ide/src/bridge/methods.ts  ← 契约源头
  └─→ HTTP API → pi-agent-server
                    ↑
                    └─ platform/apps/pi-agent-ide 通过 SSE/HTTP 访问

  platform/apps/pi-agent-ide
    ├─→ packages/shared-types（共享 types）
    ├─→ packages/api-types（HTTP API 类型）
    └─→ HTTP API → pi-agent-server
```

**关键**：

- **pi-agent-idea 跟 pi-agent-ide 之间没有编译期依赖**（跨技术栈），靠"读源码对齐契约"
- **pi-agent-ide 跟 pi-agent-web 完全独立**，不共享业务组件（决策 D7=C），只通过 `packages/shared-types` 共享 types
- **pi-agent-ide 不直接调 IDE bridge**，通过 `window.__ideBridge`（JCEF 注入）调用，接口契约稳定在 3 个方法（invoke/on/getEnv）

## 关键决策回顾

| # | 决策 | 答案 | 理由 |
|---|---|---|---|
| D1 | 通信协议 | HTTP + SSE | 跟 web 端一致，server 已有 |
| D2 | UI 形态 | Chat 用 JCEF，管理用 Swing | JCEF 渲染 Markdown 体验好；管理功能简单，Swing 足够 |
| D3 | IDE 能力暴露 | 被动模式（JVM bridge 注入）| 权限/通知等走 SSE event → JCEF 渲染 → 调用 bridge |
| D4 | server 部署 | 独立进程 | 跟 web 端复用 server，最简 |
| D5 | session 共享 | MVP 暂不考虑 | 待定 |
| D6 | 静态资源位置 | server 托管（`pi-agent-ide` 构建产物由 server 暴露）| JCEF = Chromium，可以像浏览器一样拉 server URL；单一部署位置 |
| D7 | IDEA UI 跟 web 关系 | C：独立 Vue 项目 | 一开始无负担，功能稳定后再看是否有抽离价值 |
| D8 | IDE bridge 设计 | 通用接口（invoke/on/getEnv）+ method 名路由 + Markdown 约定 | 接口稳定，新增功能不动接口 |
| D9 | 契约同步方式 | 读源码 + 集成测试 round-trip | 不放独立契约包，轻量 |
| D10 | 多 IDE 支持 | 当前只 IDEA，未来加 VS Code 平级 | 不绑死技术栈命名（`pi-agent-ide` 而非 `pi-agent-jcef`）|

## 整体数据流

```
┌─────────────────────────────────────────────────────────────────┐
│ IntelliJ IDEA                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Swing Tool Window（顶层 JTabbedPane，只负责切标签）         │  │
│ │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │  │
│ │  │ Agents   │ │Sessions │ │Settings  │ │ Chat ★    │     │  │
│ │  │ (Swing)  │ │ (Swing) │ │ (Swing) │ │ (JCEF)   │     │  │
│ │  └──────────┘ └──────────┘ └──────────┘ └─────┬────┘     │  │
│ │                                                │          │  │
│ │   Chat 标签页（100% JCEF，无 Swing 层）：       │          │  │
│ │   ┌─ JBCefBrowser（占满整个标签页内容）───────┐│          │  │
│ │   │  loadURL("http://localhost:3000/ide/    ││          │  │
│ │   │          ?sessionId=&agentId=&source=idea")││          │  │
│ │   │                                          ││          │  │
│ │   │  ┌─ Vue 顶部 toolbar ──────────────────┐ ││          │  │
│ │   │  │ [agent▾] [model▾] [history▾]  [abort]│ ││          │  │
│ │   │  └──────────────────────────────────────┘ ││          │  │
│ │   │  ┌─ Vue 消息流 ─────────────────────────┐ ││          │  │
│ │   │  │ MessageList（Markdown + 代码高亮）    │ ││          │  │
│ │   │  │ ...                                   │ ││          │  │
│ │   │  └──────────────────────────────────────┘ ││          │  │
│ │   │  ┌─ Vue 输入框 ─────────────────────────┐ ││          │  │
│ │   │  │ InputBox（@补全 / /命令 / #agent）    │ ││          │  │
│ │   │  │ [attach📎]                  [send]    │ ││          │  │
│ │   │  └──────────────────────────────────────┘ ││          │  │
│ │   │                                          ││          │  │
│ │   │  window.__ideBridge (注入) ─────────────┐││          │  │
│ │   │   ├─ invoke(method, params) ─────────────┤││          │  │
│ │   │   ├─ on(event, listener) ────────────────┤││          │  │
│ │   │   └─ getEnv() ──────────────────────────┘││          │  │
│ │   └──────────────────────────────────────────┘│          │  │
│ └────────────────────────────────────────────────┼────────────┘  │
│                                                  │               │
│  Kotlin 侧（JBCefJSQuery 路由）：                │               │
│   ┌─────────────────────────────────────────────┐│               │
│   │ query.inject("...") 把 JS 调用转给 handler  ││               │
│   │   → IdeaIdeBridge.invoke(method, params)    ││               │
│   │   → handlers map 路由                      ││               │
│   │   → IntelliJ Platform API 调用             ││               │
│   └─────────────────────────────────────────────┘│               │
└──────────────────────────────────────────────────┼───────────────┘
                                                   │
                                       HTTP / SSE  │
                                                   ↓
┌─────────────────────────────────────────────────────────────────┐
│ pi-agent-server (Node.js, hono)                                │
│   ├─ /api/agents/*           已有                              │
│   ├─ /api/sessions/*         已有                              │
│   ├─ /api/sessions/:id/events (SSE) 已有                        │
│   ├─ /web/*                  静态：pi-agent-web 产物           │
│   └─ /ide/*                  ⭐静态：pi-agent-ide 产物          │
└─────────────────────────────────────────────────────────────────┘
                                                   │
                                              IPC (Call/Event)
                                                   ↓
┌─────────────────────────────────────────────────────────────────┐
│ worker (session-worker 子进程)                                  │
│   pi SDK → LLM                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 关键路径：用户在 IDEA 端发一条消息

```
1. 用户在 JCEF 输入框打字，点击"发送"
2. InputBox 组件 → useSSE 发 POST /api/sessions/:id/prompt
3. server master：
   a. 占位 row（如还没有）→ spawn worker
   b. IPC 调 worker.prompt
   c. worker → pi SDK → LLM 流式响应
4. worker 通过 IPC 推 events → master
5. master 通过 SSE 推到所有订阅者（包括 IDEA 端 JCEF）
6. useSSE 收到事件 → 更新 Vue 响应式状态 → MessageList 自动重渲染
7. 流式结束 → emit agent_end event → 关闭流
```

### 关键路径：用户点击消息中的文件链接

```
1. MessageList 渲染消息时检测到 file:// 或 server 返回的 file path
2. 用户点击
3. 组件调用 useIdeBridge().invoke('ide.openFile', { path, options })
4. window.__ideBridge.invoke → JBCefJSQuery → Kotlin handler
5. Kotlin 解析 method 名 → handlers['ide.openFile'](params)
6. 调用 IntelliJ Platform API：FileEditorManager.openFile + caretModel.moveToLogicalPosition
7. 编辑器打开文件并跳转到指定行/列
```

## 阶段化路径（MVP → 完善）

### Phase 1：MVP —— 跑通最小闭环

- [ ] `pi-agent-ide` 项目脚手架（Vue 3 + Vite，复用 web 端 vite 配置经验）
- [ ] IDE bridge 通用接口 + method 路由 + web fallback
- [ ] IntelliJ 插件脚手架（Gradle + IntelliJ Platform）
- [ ] Tool Window 注册 + Chat 标签页（Swing tab 内嵌 JBCefBrowser）
- [ ] Agents/Sessions 列表（Swing 实现，调 server API）
- [ ] server 静态目录增加 `/ide/`
- [ ] 端到端：创建 agent → 创建 session → 在 IDEA 端对话 → 收到流式消息
- [ ] 文件链接点击 → IDE 打开编辑器
- [ ] 主题同步：IDE 主题切换 → JCEF 跟随

### Phase 2：完善体验

- [ ] @ 补全（IDE 内的符号、文件）
- [ ] "附加当前选区"按钮
- [ ] "附加当前文件"按钮
- [ ] workspace 信息显示（git branch 等）
- [ ] abort API（IDE 端取消）
- [ ] Diff Viewer 集成（applyPatch 后显示 diff）
- [ ] 权限请求走 SSE event → JCEF 渲染弹窗 → 用户确认 → POST 回 server

### Phase 3：原生集成（可选）

- [ ] Editor 右键菜单（"问 AI 关于这个 symbol"）
- [ ] Quick Fix（错误解释、AI 修复建议）
- [ ] VCS 集成（commit message 生成、diff 解释）

## 待定 / Open Questions

- **OQ1：D5 session 共享** —— MVP 暂不做，待跟 web 端协同决定
- **OQ2：token 认证** —— JCEF 加载 server URL 的认证方案（cookie / Bearer token / 注册端点）待定
- **OQ3：server 不可用时的 JCEF fallback** —— 显示本地静态错误页？or 禁用 Chat tab？待定
- **OQ4：服务端 SSE channel 感知** —— server 是否需要知道"有 IDEA 客户端连上来了"（统计/广播用）？MVP 暂不需要

## 相关条目

- [`pi-agent-idea_ide-bridge.md`](pi-agent-idea_ide-bridge.md) —— IDE bridge 接口设计（invoke/on/getEnv + method 路由 + 跨语言同步 + JCEF 注入）
- 决策来源（仅参考，不迁移）：`reference/projects/personal-agent-manage/doc/decisions/20-server-sdk-orchestrator-with-worker-pool.md`
- 旧 IDEA 插件（仅参考，不迁移）：`reference/projects/personal-agent-manage/agent-manage-plugin/`