# pi-agent-platform

> 本文件只列**位置**和**规则**，不重复内容。详细规范去各目录的 README。

## 项目定位

**个人通用 agent 管理平台。** Server 升级为 SDK orchestrator + worker pool，多渠道接入（IDE / Web / QQ / 微信）。

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
- **pi 知识库双挂钩**（规则详见 [`.pi/skills/pi-knowledge/SKILL.md`](.pi/skills/pi-knowledge/SKILL.md)）：**翻之前**——任何任务只要即将打开 pi 官方 docs / 源码 / dist，先读 `reference/pi-knowledge/README.md` 索引（命中可能免翻，未命中带着“已有什么”去翻）；**翻之后**——获得了有价值信息（官方 docs 没写的、反直觉的、实证过的坑/契约/坐标）**直接沉淀**进知识库，不需用户点名“沉淀”
- **提议**（不主动做）：changelog 条目、AGENTS.md 修订、新增子项目
- **日志统一走 pino logger**（JSON 结构化，单时间线）：server 用 `apps/pi-agent-server/src/logger.ts` 的 `childLogger('<module>')`，worker 用 `workers/session-worker/src/logger.ts`（stderr 输出，自动 tee 进主日志并带 sessionId/workerPid，同时保留 `stderrTail` 供 `/debug/sessions/:id`）。级别约定：运行事件 info/warn/error，诊断信息用 debug（`LOG_LEVEL=debug` 才可见）

### agent 不做（红线）

- ❌ **主动 commit / push** —— 人来 review
- ❌ **删除文件 / 目录** —— 改前先问
- ❌ **修改本文件核心规则** —— 必须人确认
- ❌ **写测试除非明确要求** —— 不主动加（**debug 接口 + curl 端到端验证是首选**——见 `doc/architecture/current/pi-agent-server_debug-testing.md`）
- ❌ **用 `console.*` 打日志** —— 统一用 pino logger（见上）；console 已被桥接进 logger，只留给第三方 SDK 输出与启动横幅

### 修 bug 流程

修 bug 后**默认**走以下流程：

1. **编译验证**：`pnpm -r typecheck`
   - dev 态 tsx 直跑源码、**无需 build**；dist 产物只在打包部署（`pnpm pack:cli`）时才需要，见「开发环境启停与生效」。
2. **部署到开发环境**：按「开发环境启停与生效」执行 —— 后端改动启停 `dev:server`（启动 `pnpm dev:server` / 停止 `pnpm stop:server`），前端改动 `pnpm build:web` / `pnpm build:ide` 打包部署到 server 托管目录
3. **验证**：
   - **接口：自己验证** —— debug 接口 + curl 端到端（见 `doc/architecture/current/pi-agent-server_debug-testing.md`），通过才算修好
   - **UI / 聊天软件（IM）实际集成测试：通知用户**"新代码已部署到开发环境"，由用户做实际集成验证

**例外**：特别确定、非常明显的 bug（拼写错误、明显类型错误）可简化处理（可跳过部署验证），但仍应告知用户。

### 开发环境启停与生效（dev only）

```bash
pnpm dev:server        # 启动（platform/ 下执行；tsx 直跑源码、无 watch；dev 脚本内置 NODE_ENV=development + PORT=3000，并剥离全部打包态环境变量）
pnpm stop:server       # 停止（只 kill 3000 端口那一个 PID；停其他端口需显式 --port=N）
# server 在前台终端时也可 Ctrl+C（graceful）
```

**生效规则**：dev 态 TS **无需任何编译**（tsx 直跑源码），但也**无自动重载**，改完按下表生效：

| 改动 | 生效操作 |
|---|---|
| 后端（server / channels 后端 / packages / worker） | 重启 `dev:server`（`pnpm stop:server` → `pnpm dev:server`） |
| web 前端（`apps/pi-agent-web/src/**`、`channels/*/src/admin/**`） | `pnpm build:web` → 浏览器刷新，无需重启 server |
| ide 前端（`apps/pi-agent-ide/src/**`） | `pnpm build:ide` → IDEA 刷新 JCEF，无需重启 server |

注意：

- `public/web` / `public/ide` 不存在时 server 启动会跳过静态挂载 —— 首次 build 后需重启一次 server
- 改 `ide-bridge` 的 method 契约需与 Kotlin 侧同步（即使 Kotlin 代码没改）
- 只有打包态（`pi-server` CLI / `pnpm pack:cli`）才需要 dist 产物，见 `doc/architecture/current/pi-agent-server_packaging.md`

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
    │   ├── build-cli.mjs                聚合 server/worker/channels/SPA → pi-server-X.Y.Z.tgz
    │   ├── copy-spa.mjs                 SPA dist → server public/（build:web / build:ide 用）
    │   └── stop-server.mjs              按端口精确停 server（pnpm stop:server）
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
- **DB 表结构变更**:只改初始建表（drizzle schema + initDb）,**不写迁移逻辑**——schema 变了重建库即可,不考虑旧数据兼容
- **顶部菜单数据驱动**:Vue Router `meta.navLabel / navOrder / navIcon` 字段驱动 TopNav
- **cli 打包 + 双模式启动**:server 进程可由 npm 全局 `pi-server` 启动（`PI_SERVER_CLI=1` marker 注入绝对路径，dev 态用相对路径 fallback）