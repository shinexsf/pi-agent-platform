# pi-agent-platform

> 本文件只列**位置**和**规则**，不重复内容。详细规范去各目录的 README。

## 项目定位

**个人 + 企业级通用 agent 管理平台。** Server 升级为 SDK orchestrator + worker pool，多渠道接入（IDE / Web / QQ / 微信）。

技术栈核心：Node.js + hono + pi SDK + child_process worker pool。

## 文档目录

| 路径 | 作用与 README                                      | 维护时机 |
|---|-------------------------------------------------|---|
| [`doc/architecture/`](doc/architecture/) | 架构文档: [README.md](doc/architecture/README.md)   | 用户要求或询问后更新，不可私自修改 |

> 个人开发日志、私域调研、OpenSpec 工作流等本地文档不随仓库发布（gitignored），由用户在本地维护。

## 人机协作规则

### agent 做

- 调研、写文档、写代码
- 改代码前**必读**对应目录的 README
- **提议**（不主动做）：changelog 条目、AGENTS.md 修订、新增子项目
- **允许** `console.error` / `console.warn` 用于关键错误路径（worker stderr 会被 `stderrTail` 收集为 `/debug/sessions/:id` 的输出，是 debug 接口能力的一部分；不要用 `console.log`）

### agent 不做（红线）

- ❌ **主动启停 server**（dev / start / restart）—— 人自己来
- ❌ **主动 commit / push** —— 人来 review
- ❌ **删除文件 / 目录** —— 改前先问
- ❌ **修改本文件核心规则** —— 必须人确认
- ❌ **写测试除非明确要求** —— 不主动加（**debug 接口 + curl 端到端验证是首选**——见 `doc/architecture/current/pi-agent-server_debug-testing.md`）
- ❌ **生产代码调试用 `console.log` 代替 pino logger**（IM gateway 已配 pino，参考 `apps/pi-agent-server/src/im-gateway/logger.ts`）

### 修 bug 流程

修 bug 后**默认**走以下流程：

1. **编译验证**：`pnpm -r typecheck` + `pnpm --filter session-worker build`
   - ⚠️ **必须 build**：worker 是 `tsc` 产出 dist 给 server spawn 的（`worker-pool.ts:resolveWorkerEntry` 优先用 `dist/index.js`），server 不直接跑 src。**只改 src 不 build 不会生效**。typecheck 过 ≠ 运行有效。
   - 其他被 server 主进程 `import()` 的 packages（`api-types` /`ipc-protocol` /`shared-types`）server 会重载，但 worker 路径是按产物文件 spawn，需要单独 build。
2. **告知用户**：报告"OK，重启测试"，让用户自己启 server 验证

**例外**：特别确定、非常明显的 bug（拼写错误、明显类型错误）可简化处理，但仍应让用户确认是否需要验证。

**配套红线**：本节与"❌ 主动启停 server"红线配套 —— 默认不要启 server 验证修复，编译过即交付用户。

## 必读

进入项目工作前：

1. [`doc/architecture/`](doc/architecture/) —— 架构总入口

## 平台代码总览

```
pi-agent-platform/                      仓库根
├── AGENTS.md                            本文件
├── doc/                                 文档（architecture）
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
    │   ├── api-types/                   REST API DTO
    │   └── cli/                         pi-server CLI 工具（npm install -g 后 start/stop/status/logs）
    ├── scripts/
    │   └── build-cli.mjs                聚合 server/worker/channels/SPA → pi-server-X.Y.Z.tgz
    └── channels/                        IM 渠道包（按 manifest 动态装载）
        ├── manifest.json                启用渠道清单
        ├── shared/                      channels 内部共享 logger + registry（plain JS）
        ├── channel-wechat/              WeChat iLink ClawBot
        └── channel-qq/                  QQ Bot (p2p only MVP)
```

> **注**：`pi-agent-idea/`（IntelliJ 插件）跟 `platform/`（Node.js monorepo）**平行**，在仓库根。`platform/apps/pi-agent-ide/`（Vue SPA）是 server 通过 `/ide/` 路径静态托管的 IDE 端 UI，跟 `pi-agent-idea/` 插件配合使用——JCEF 内嵌加载 `pi-agent-ide/`，跟 Kotlin 端通过 `ide-bridge` RPC 通信。
>
> **架构详情**见 `doc/architecture/current/` 子模块文档（特别是 `pi-agent-idea_overview.md` + `pi-agent-idea_ide-bridge.md`）。

## 关键架构原则（P1）

- **5 个接口 + 严格调用方向**:见 `packages/channel-types/README.md`。主包对渠道实现零知识。
- **manifest 动态加载**:server `await import()` + web `import.meta.glob('/channels/*/src/admin/index.ts')`(Vite 限制)
- **各渠道拥有自己的表**:channels_wechat / channels_qq 由渠道包 register 时通过 `host.executeMigration()` 自管
- **session-channel-map 内存实现**:不动 sessions 表,30 分钟 idle kill worker
- **顶部菜单数据驱动**:Vue Router `meta.navLabel / navOrder / navIcon` 字段驱动 TopNav
- **cli 打包 + 双模式启动**:server 进程可由 npm 全局 `pi-server` 启动（`PI_SERVER_CLI=1` marker 注入绝对路径，dev 态用相对路径 fallback）