# pi-agent-platform

**Server orchestrator**：基于 pi SDK 的多渠道 AI agent 接入层。
Server 通过 per-session worker pool 隔离会话，多渠道接入（IDE / Web / QQ / 微信）。

技术栈核心：Node.js + hono + pi SDK + child_process worker pool。

## 平台代码总览

```
pi-agent-platform/
├── AGENTS.md                            本文件（项目说明）
├── README.md / LICENSE
├── doc/architecture/                    架构文档
│
├── pi-agent-idea/                       IntelliJ 插件（Kotlin + Gradle）—— 在仓库根，不在 platform/ 里
│
└── platform/                            Node.js monorepo（pnpm workspace）
    ├── apps/                            可独立部署的应用
    │   ├── pi-agent-ide/                Vue 3 SPA（IDE 端 JCEF 加载，server 静态托管在 /ide/）
    │   ├── pi-agent-server/             Hono + worker-pool + IM gateway 后端
    │   │   └── src/im-gateway/          IM gateway host 模块（QQ/微信渠道装载 + 路由 + 内存 session map）
    │   └── pi-agent-web/                Vue 3 SPA（浏览器端）
    │       └── src/modules/im-gateway/  web 端 IM gateway 模块（glob 发现 + TopNav + Admin 包装）
    ├── workers/
    │   └── session-worker/              每 session 一个的 pi SDK 容器（worker 进程，tsc 产 dist）
    ├── packages/                        共享 types + protocol
    │   ├── channel-types/               5 个 IM 渠道接口（dual-target: Node + DOM）
    │   ├── ipc-protocol/                master↔worker IPC 类型
    │   ├── sdk-integration/             worker 跟 pi SDK 通信的适配层
    │   ├── shared-types/                跨包共享类型
    │   └── api-types/                   REST API DTO
    └── channels/                        IM 渠道包（按 manifest 动态装载）
        ├── manifest.json                启用渠道清单
        ├── channel-wechat/              WeChat iLink ClawBot
        └── channel-qq/                  QQ Bot (p2p only MVP)
```

> **注**：`pi-agent-idea/`（IntelliJ 插件）跟 `platform/`（Node.js monorepo）**平行**，在仓库根。`platform/apps/pi-agent-ide/`（Vue SPA）是 server 通过 `/ide/` 路径静态托管的 IDE 端 UI，跟 `pi-agent-idea/` 插件配合使用——JCEF 内嵌加载 `pi-agent-ide/`，跟 Kotlin 端通过 `ide-bridge` RPC 通信。
>
> 架构详情见 `doc/architecture/current/` 子模块文档（特别是 `pi-agent-idea_overview.md` + `pi-agent-idea_ide-bridge.md`）。

## 关键架构原则

- **5 个接口 + 严格调用方向**：见 `platform/packages/channel-types/`。主包对渠道实现零知识。
- **manifest 动态加载**：server `await import()` + web `import.meta.glob('/channels/*/src/admin/index.ts')`（Vite 限制）
- **各渠道拥有自己的表**：channels_wechat / channels_qq 由渠道包 register 时通过 `host.executeMigration()` 自管
- **session-channel-map 内存实现**：不动 sessions 表，30 分钟 idle kill worker
- **顶部菜单数据驱动**：Vue Router `meta.navLabel / navOrder / navIcon` 字段驱动 TopNav
