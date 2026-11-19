# doc/architecture/

子模块架构文档总入口。

## 子模块架构索引

子模块架构文档与本索引同目录（平铺，不再分子目录）。本表是入口索引。

**命名规则**：`doc/architecture/<子项目英文名>_<子模块英文名>.md`

| 子项目 | 子模块 | 文档 | 摘要 |
|---|---|---|---|
| pi-agent-server | overview | [架构概览](pi-agent-server_overview.md) | 分层全景图（**入口 / 内核 / 投影包** + 事件回流）+ 核心思想（含分层说明）+ 子模块索引 + 待决项 | **2026-11-17** |
| pi-agent-server | worker-pool | [Worker Pool](pi-agent-server_worker-pool.md) | master 进程管理的 worker 子进程池；**进程域 only**（领域字段归 Session，placeholder 判据注入 hasRowQuery）+ `session_event` 只转发 + **反向注册入口 `registerService(source, …, handlers)`（服务级注册 + 命名校验）** | **2026-11-17** |
| pi-agent-server | core-sdk | [会话内核](pi-agent-server_core-sdk.md) | **`@pi-agent-platform/core` 的边界**：内核最小集清单（db/repos/session/worker-pool/capabilities/插件宿主/配置注入）+ **硬规则「内核只建内核对象的表」**（其余表由模块自带迁移，新库只剩 agents/sessions/attachments）+ 宿主 API 六个面（db/sessions/lifecycle/outbound/events/web）+ **订阅契约（多订阅者 / 幂等退订 / 终态通知 / 慢订阅者丢弃不回压）** + 能力控制面归属（机制在内核、平台功能组靠注册）+ 入口 `createServerApp` 与 `main` 分离 + **可执行验收 `pnpm verify:sdk`（依赖闭包静态断言 + 无 HTTP 进程跑一轮）** + 打包三要求 | **2026-11-17** |
| pi-agent-server | ipc | [IPC 协议](pi-agent-server_ipc.md) | **同形信封（call / reverse-call 只差 kind）** + **两张方法注册表（worker 持正向表、master 持反向表）为分发唯一依据** + 命名规则（内置无前缀 / 插件强制 `plugin.<id>.`）+ 错误语义（unknown / disabled / deprecated）+ `ready` 握手带注册表摘要 + `GET /api/runtime/methods` + **三通道时序图** + `createSession` 三段式入参 + 反向方法 `plugin.im.sendFile` / `plugin.notifications.post` / `plugin.admin.invoke` + **标题同步通道** + **事件层分工：worker 只做无损 coalescing、事件名开放（pi 原生类型，无白名单）、投影在独立包、入口只做序列化与限流** | **2026-11-17** |
| pi-agent-server | session-lifecycle | [Session 生命周期](pi-agent-server_session-lifecycle.md) | 创建 / 销毁 / 配置管理 / 状态机 + **SessionRegistry 单入口（getOrCreate/createFromAgent）+ Session 领域对象（对象生命周期 = worker 生命周期）** + **Session title 双向同步** + **恢复时 session 行配置优先** + **builtinTools 含扩展工具名时注入 builtin:<ext>（additionalExtensionPaths 触发装载）** | **2026-10-20** |
| pi-agent-server | db-schema | [DB Schema](pi-agent-server_db-schema.md) | agents / sessions / attachments / **agent_templates** 表（**ER 图**） + AgentConfig 各字段语义（**所有清单字段缺失即空**，capabilities 例外） | **2026-10-21** |
| pi-agent-server | http-api | [HTTP API](pi-agent-server_http-api.md) | v1 路由 + SSE 协议（含 **`session_disposed` 终态事件 + 关流重连**、订阅经 Session） + 服务器默认配置端点 + **改名端点 pi 同步语义** + **GET /api/capabilities** + **`/api/templates` CRUD** + builtin-providers 动态化 + systemPrompt 字段机制更新 + **插件端点（静态事实 `/api/plugins*` vs 运行期注册 `/api/extensions`、`/api/plugins/:id/extensions`、`/api/sessions/:id/extensions`、`/api/p/<id>/*`、`/plugins/<id>/web/*`、`/plugin-page/*`）** | **2026-11-05** |
| pi-agent-server | im-gateway | [IM Gateway](pi-agent-server_im-gateway.md) | QQ + 微信渠道包（后端 + 前端一体化）；5 个接口；manifest dynamic import；23 条 API；**四态 ensureSession 共享实现（ensure-session.ts）+ 斜杠命令分层（会话级经 Session.executeCommand）**；统一 `<file>` 附件标签；附件管道；重启会话恢复 B2 fallback | **2026-09-30** |
| pi-agent-server | logging | [日志](pi-agent-server_logging.md) | 统一结构化日志：pino JSON 单时间线（master/worker/channels/第三方 console）；worker stderr tee；RollingFileSink 固定名滚动 10MB×5 |
| **pi-agent-server** | **capabilities** | **[能力控制面](pi-agent-server_capabilities.md)** | **agent → 宿主 server 管理能力：`callServer` meta-tool（默认关）+ master 控制面（registry → dispatch → 授权 → 审计）；双道闸（serverBuiltinTools 注入 × capabilities opt-in allowlist + 硬编码 own 安全网）；description/list/detail 按授权同源过滤；v1 8 能力 + WebUI 三处 + debug 端点**；builtinTools 升级为「纯工具 + 内置扩展工具」统一清单（codemode/tool_search/mcp 按名装载，含 powershell）；**配置单层显式清单（删全局资源默认层，缺失即空，无效项标注）** | **2026-10-21** |
| pi-agent-server | debug-testing | [Debug Testing](pi-agent-server_debug-testing.md) | Debug 接口 = unit tests 替代品；server `/debug/*` 端点 + **`/debug/capabilities*` 授权矩阵入口** + `GET /api/im/debug/state`；`/api/im/events` 已转正为正式端点；debug 代码解耦三约束（单向依赖 / 可剥离 / 正式包零加载）；dev-only gating；不要写 unit tests 用 curl 端到端 | **2026-09-30** |
| **pi-agent-server** | **packaging** | **[Packaging & Distribution](pi-agent-server_packaging.md)** | **`pi-server` npm tarball；`PI_SERVER_CLI` marker 双模式启动；8 个打包态环境变量 + `PORT` 强制覆盖；`server.log` 固定名滚动 + `server.console.log` 兜底；channels/shared/ 副本解决 workspace 内部包依赖；tarball 不含 node_modules；better-sqlite3 走 npm 标准 install hook** | **2026-09-30** |
| **pi-agent-server** | **plugins** | **[插件机制（v1 背景）](pi-agent-server_plugins.md)** | **⚠️ 已由 plugin-mechanism-v2 替换，保留作背景**（装载流程 / 会话级依赖闸门 / 双向窄桥三块未变）；正文里逐条标注了「v1 已废弃」：facet 开关、`installedAt`、精确匹配路由、不做热加载 | **2026-11-18** |
| **pi-agent-server** | **plugins-runtime** | **[插件运行期 v2](pi-agent-server_plugins-runtime.md)** | **代码即行为契约**：4 个装载点 × **10 个注册扩展点**（R1 页面 / R2 段级路由 / R3 反向方法 / R4 迁移 / R5 正向方法 / R6–R8 pi 扩展 / R9 挂载点 / R10 工具卡）+ **5 个能力面**（sessions / agents / db / lifecycle / events）+ 生命周期（import 带 cache bust → **零副作用断言** → init → **disposer 账本** → 卸载归零）+ **bundled 目录 vs 用户 registry**（三行台账 + 墓碑 + 卸载保留数据）+ inline 插件（`callServer`）+ 验收 `pnpm verify:plugins` | **2026-11-18** |
| **pi-agent-server** | **plugins-manual** | **[插件作者契约 v2](pi-agent-server_plugins-manual.md)** | **面向作者**：三十秒上手 → 目录与 `package.json`（只留 `apiVersion` / `requires`）→ 四个装载点的默认导出写法 → 宿主能力面表 → **vendored 类型**（不走 peerDependencies）→ `plugin check` / `plugin list` / `plugin reload` / REST 自查 → 打包分发 → 已知坑 → 参考示例 | **2026-11-18** |
| pi-agent-server | invariants | [不变量](pi-agent-server_invariants.md) | 架构层 hard rules（不能动）；含 **Session 服务层**（registry 单入口 / 域状态归 Session / 事件订阅归 Session / 核心零 im-gateway 反向依赖）+ **IPC 协议**（注册表是分发唯一依据 / 插件前缀强制 / 插件不碰裸 IPC / 信封同形 / 事件无回执 / 反向 60s / 无版本字段）| **2026-11-17** |
| pi-agent-server | notifications | [系统通知](pi-agent-server_notifications.md) | **独立子系统，不绑触发器**：系统通知表 + 唯一内部写入口 `notify()`（**两个产生方**：agent 工具 `postNotification` / server 异常）+ 只读收件箱；**平台不对外投递**（无渠道、无重试、无消费游标，外部推送由 MCP/插件/脚本自行消费读接口） | **2026-11-10** |
| pi-agent-server | builtin-skills | [平台随包 Skill](pi-agent-server_builtin-skills.md) | **平台级 skill 通道**：`AgentConfig.serverBuiltinSkills`（显式、默认全关、与用户 `skills` 两套名字空间）+ 包内 `skills/builtin/<name>/SKILL.md` + `GET /api/config/server-builtin-skills`（只读）+ 候选路径解析 → `PI_SERVER_BUILTIN_SKILLS_DIR` → worker 求交集喂 pi `additionalSkillPaths`（pi 判 `temporary`，**绕开 skill 白名单是契约**）+ 名字失效进 issues + 三条软提示 + 打包/自检要求 | **2026-11-09** |
| pi-agent-web | overview | [架构概览](pi-agent-web_overview.md) | Vue 3 + Tailwind v4 + 自写业务组件 + 不引入重组件库；**配置三处去继承（单层清单 + 全选/清空/无效项标注）、默认设置三项、配置模板（`/templates` + 填充/存为模板）** | **2026-10-21** |
| pi-agent-web | architecture-diagrams | [架构图集](pi-agent-web_architecture-diagrams.md) | `/architecture` 两级切换器（集合 × 图）；图源 spec 进仓 + archify 编译产物双轨（`architecture/*.json` → `public/architecture/*.html`）；集合 `platform`（本平台，节点带仓库 `sources`）与 `pi`（原生 pi，版本钉标题、结论回流 pi 知识库）；URL `?set=&d=`、localStorage 记忆、空集合占位 | **2026-11-07** |
| pi-agent-idea | overview | [架构概览](pi-agent-idea_overview.md) | IntelliJ 客户端：Kotlin 插件 + Vue UI 双模块；Chat 用 JCEF、管理用 Swing；server 托管静态资源；MVP 已实施；**路径约定：跨 bridge / 跨 HTTP 的路径一律 server 形态（WSL 场景 /home/x，IDE 侧 UNC 只在碰文件系统时出现）** | **2026-11-05** |
| pi-agent-idea | ide-bridge | [IDE Bridge](pi-agent-idea_ide-bridge.md) | JCEF ↔ Kotlin 桥接：通用 invoke/on/getEnv 接口 + method 名路由表 + 跨语言契约同步（9 个集成测试覆盖）+ **路径约定（`paths/PathMapper`：`\\wsl.localhost\<distro>` ⇄ `/` 整盘级映射，出站/入站 7 处显式转换，`getWorkspace` 给 root/localRoot/distro）** | **2026-11-05** |

> 子模块文档**新增 / 重命名 / 删除**时，本表必须同步更新。
