# doc/architecture/

子模块架构文档总入口。

## 子模块架构索引

子模块架构文档在 [`current/`](current/) 下。本表是入口索引。

**命名规则**：`current/<子项目英文名>_<子模块英文名>.md`

| 子项目 | 子模块 | 文档 | 摘要 |
|---|---|---|---|
| pi-agent-server | overview | [架构概览](current/pi-agent-server_overview.md) | 系统全景图 + 核心思想一段话 |
| pi-agent-server | worker-pool | [Worker Pool](current/pi-agent-server_worker-pool.md) | master 进程管理的 worker 子进程池 | **2026-09-24** |
| pi-agent-server | ipc | [IPC 协议](current/pi-agent-server_ipc.md) | AgentSessionProxy + 极简 IPC 协议 + **标题同步通道（setSessionName / session_info_changed / sessionName）+ invokeCapability 统一反向入口** | **2026-09-24** |
| pi-agent-server | session-lifecycle | [Session 生命周期](current/pi-agent-server_session-lifecycle.md) | 创建 / 销毁 / 配置管理 / 状态机 + **Session title 双向同步** + **恢复时 session 行配置优先（capabilities 缺 key 回落 agent）** | **2026-09-24** |
| pi-agent-server | db-schema | [DB Schema](current/pi-agent-server_db-schema.md) | agents + sessions 两张表 + AgentConfig 的 serverBuiltinTools / capabilities 字段 | **2026-09-24** |
| pi-agent-server | http-api | [HTTP API](current/pi-agent-server_http-api.md) | v1 路由 + SSE 协议 + 服务器默认配置端点 + **改名端点 pi 同步语义（session_info_changed 不进 SSE）** + **GET /api/capabilities** | **2026-09-24** |
| pi-agent-server | im-gateway | [IM Gateway](current/pi-agent-server_im-gateway.md) | QQ + 微信渠道包（后端 + 前端一体化）；5 个接口；manifest dynamic import；23 条 API；统一 `<file>` 附件标签；附件管道（adapter→store→prompt-resolver→worker）；重启会话恢复 B2 fallback |
| pi-agent-server | logging | [日志](current/pi-agent-server_logging.md) | 统一结构化日志：pino JSON 单时间线（master/worker/channels/第三方 console）；worker stderr tee；RollingFileSink 固定名滚动 10MB×5 |
| **pi-agent-server** | **capabilities** | **[能力控制面](current/pi-agent-server_capabilities.md)** | **agent → 宿主 server 管理能力：`callServer` meta-tool（默认关）+ master 控制面（registry → dispatch → 授权 → 审计）；双道闸（serverBuiltinTools 注入 × capabilities opt-in allowlist + 硬编码 own 安全网）；description/list/detail 按授权同源过滤；v1 8 能力 + WebUI 三处 + debug 端点** | **2026-09-24** |
| pi-agent-server | debug-testing | [Debug Testing](current/pi-agent-server_debug-testing.md) | Debug 接口 = unit tests 替代品；server `/debug/*` 端点 + **`/debug/capabilities*` 授权矩阵入口** + `GET /api/im/debug/state`；`/api/im/events` 已转正为正式端点；debug 代码解耦三约束（单向依赖 / 可剥离 / 正式包零加载）；dev-only gating；不要写 unit tests 用 curl 端到端 | **2026-09-24** |
| **pi-agent-server** | **packaging** | **[Packaging & Distribution](current/pi-agent-server_packaging.md)** | **`pi-server` npm tarball；`PI_SERVER_CLI` marker 双模式启动；8 个打包态环境变量 + `PORT` 强制覆盖；`server.log` 固定名滚动 + `server.console.log` 兜底；channels/shared/ 副本解决 workspace 内部包依赖；tarball 不含 node_modules；better-sqlite3 走 npm 标准 install hook** | **2026-09-22** |
| pi-agent-server | invariants | [不变量](current/pi-agent-server_invariants.md) | 架构层 hard rules（不能动） |
| pi-agent-web | overview | [架构概览](current/pi-agent-web_overview.md) | Vue 3 + Tailwind v4 + 自写业务组件 + 不引入重组件库 |
| pi-agent-idea | overview | [架构概览](current/pi-agent-idea_overview.md) | IntelliJ 客户端：Kotlin 插件 + Vue UI 双模块；Chat 用 JCEF、管理用 Swing；server 托管静态资源；MVP 已实施 |
| pi-agent-idea | ide-bridge | [IDE Bridge](current/pi-agent-idea_ide-bridge.md) | JCEF ↔ Kotlin 桥接：通用 invoke/on/getEnv 接口 + method 名路由表 + 跨语言契约同步（9 个集成测试覆盖） |

> 子模块文档**新增 / 重命名 / 删除**时，本表必须同步更新。
