# pi-agent-platform

> 本文件只列**位置**和**规则**，不重复内容。详细规范去各目录的 README。

## 项目定位

**个人通用 agent 管理平台。** Server 升级为 SDK orchestrator + worker pool，多渠道接入（IDE / Web / QQ / 微信）。

技术栈核心：Node.js + hono + pi SDK + child_process worker pool。

## 文档目录

| 路径 | 作用与 README                                      | 维护时机 |
|---|-------------------------------------------------|---|
| [`doc/architecture/`](doc/architecture/) | 架构文档: [README.md](doc/architecture/README.md)   | 用户要求或询问后更新，不可私自修改 |

> `openspec/`（OpenSpec 工作流）、`tmp/`、`test-workspace/` 在主仓库根、gitignored，由用户在本地维护。
>
> 开发日志 / 想法 / 架构变更史 / pi 源码知识库属于**私域文档**，在独立仓库里维护，读写流程由 `arch-docs` / `dev-journal` / `ideas` / `pi-knowledge` 四个 skill 各自说明；主仓库 `doc/` 下不要再新建私域目录。
>
> **文档自包含**：主仓库 `doc/` 下的公开文档只引用仓库内文件，不得出现私域文档、`openspec/`、`tmp/` 等仓库外路径（要提就写主题名）。

## 人机协作规则

### agent 做

- 调研、写文档、写代码
- 改代码前**必读**对应目录的 README
- **pi 知识库双挂钩**（`pi-knowledge` skill）：**翻之前**——即将打开 pi 官方 docs / 源码 / dist 时，先查知识库索引（命中可能免翻，未命中带着“已有什么”去翻）；**翻之后**——有价值信息（官方 docs 没写的、反直觉的、实证过的坑/契约/坐标）**直接沉淀**，不需用户点名“沉淀”
- **提议**（不主动做）：changelog 条目、AGENTS.md 修订、新增子项目
- **日志统一走 pino logger**（JSON 结构化，单时间线）：server 用 `apps/pi-agent-server/src/logger.ts` 的 `childLogger('<module>')`，worker 用 `workers/session-worker/src/logger.ts`（stderr 输出，自动 tee 进主日志并带 sessionId/workerPid，同时保留 `stderrTail` 供 `/debug/sessions/:id`）。级别约定：运行事件 info/warn/error，诊断信息用 debug（`LOG_LEVEL=debug` 才可见）
- **私域仓库交付**：改完一批私域文档或 skill 后，按对应 skill 的「收尾」步骤提交并推送（含 skill 自身更新）；主仓库改动不提交，交人 review
- **临时文件统一放 `tmp/YYYY-MM-dd/`**（已 gitignore）：诊断脚本、测试 payload、抓包/截图、导出的 json 等都放这里；不要在仓库根留 `.tmp-*` 之类散落目录
- **mermaid 图校验**：写/改文档里的 mermaid 代码块后，跑 `cd platform && node scripts/check-mermaid.mjs`（真实 `mermaid.parse`，全量扫 `doc/`；坏块报 `文件:行号` 并退出 1；也可传路径只验指定文件）。mermaid + jsdom 是 workspace devDependencies；`arch-docs` skill 已内置这一步，更新架构文档带图变更时必须过

### agent 不做（红线）

- ❌ **主动 commit / push** —— 人来 review
- ❌ **删除文件 / 目录** —— 改前先问
- ❌ **修改本文件核心规则** —— 必须人确认
- ❌ **写测试除非明确要求** —— 不主动加（**debug 接口 + curl 端到端验证是首选**——见 `doc/architecture/pi-agent-server_debug-testing.md`）
- ❌ **用 `console.*` 打日志** —— 统一用 pino logger（见上）；console 已被桥接进 logger，只留给第三方 SDK 输出与启动横幅

### 测试产物一律放 `test-workspace/`（硬约定）

**任何**测试用 agent / 探针会话，`workspacePath` 必须指向仓库根的 `<仓库根>/test-workspace/<子目录>`：

- 子目录名与 agent 名一致，便于识别与清理；探针类用 `*-probe`，自检类用 `selfcheck-*`
- ❌ 不得指向业务项目（如 `Jieyou/*`）、用户真实工作区、或平台自身目录（平台自身仅允许只读排查）
- 测试要特定 cwd 下的配置（如 `<cwd>/.pi/settings.json`）就在该子目录里自建，不要改用户已有配置
- 测试结束**在报告里标注产物**（agent 名 / session id / 目录），清理用 `POST /api/agents/:id/delete`
- 理由：`test-workspace/` 已 gitignore；避免污染业务仓库、避免把真实配置/密钥写到错误目录、避免留下指向真实项目的僵尸 agent

细节（自检 agent 的 skill/fixture 布局、断言流程）见 `llm-integration-testing` skill。

### 非 bundled 插件代码放哪（硬约定）

| 桶 | 路径 | 谁在用 | 入库 |
|---|---|---|---|
| **bundled（要发布）** | `platform/plugins/` | 所有装 tgz 的人 | ✅ 进 tgz |
| **本机自用** | 仓库根 `plugins/` | 本机打包实例（`pi-server start`） | ❌ gitignored |
| **渠道插件** | 仓库根 `plugins/channel-<type>/` | 同上（IM 渠道：`<name>` = qq / wechat / probe） | ❌ gitignored |
| **dev 专用** | `platform/.dev-data/plugins/` | dev（`pnpm dev:server`） | ❌ gitignored |
| **坏插件 fixture** | `test-workspace/demo-plugins/` | dev，验证"坏插件会被拒" | ❌ gitignored |

- **给 dev 装插件必须先把注册表指过去**：`export PI_SERVER_PLUGINS_DIR=$PWD/platform/.dev-data/plugins`，否则 `plugin add` 会登记进**打包实例**的台账（症状：dev 没装上、本机实例莫名多一个）
- 注册表存的是**绝对路径**：`mv` 插件目录后必须重新 `plugin add`（旧路径指向空 → 插件 degraded/消失）
- 插件建的表在 `plugin remove` 时**不清**（CLI 会列出"留下的表"，要清自己 DROP）
- ❌ 不要把"只在本机生效的优化"写进 `platform/plugins/`（那是发布物）；❌ 也不要为了省事把 dev 调试插件放仓库根 `plugins/`（两边实例会用不同的插件集，排查时极难分辨）
- **渠道（IM）永远是插件，且永远不在 `platform/` 里**：网关是 bundled 插件 `platform/plugins/im/`，渠道是非 bundle 插件（`plugins/channel-<type>/`）。新渠道不进入本仓库 —— 它只提供 `<id>.channel` service 到 `im.channel` namespace，平台零改动（见 `doc/architecture/pi-agent-server_im-gateway.md`）
- 布局与命令见 `plugins/README.md` 与 `platform/.dev-data/plugins/README.md`；写插件前读 `pi-plugin-authoring` skill

### 打包态验证走 `packaged-test` skill（只在容器里测）

改到**跨包 runtime import（`@pi-agent-platform/*`）、bundled 插件（`platform/plugins/*`，含其 `skills/` 与 `web/src/*.ts`）、渠道 manifest、打包脚本、`check-packaged.mjs` 的校验项、`postinstall`**，或用户提到"验证打包 / 测正式包 / pack 一下"时：

```bash
SK=.pi/skills/packaged-test    # 项目内唯一一份（全局副本已删）
$SK/scripts/packtest.sh pack      # pnpm pack:cli（内含 check-packaged 自检）
$SK/scripts/packtest.sh install   # 容器内 npm i -g tgz → 重启
$SK/scripts/packtest.sh verify    # 从 WSL curl 127.0.0.1:9911 冒烟
```

理由：dev 态（tsx 直跑 + pnpm symlink + bundler resolution）会**静默掩盖**缺包、`dist` 缺文件、`postinstall` 没跑、`PATH` 不对——这类 bug 只在干净机器 + 安装产物里暴露。真实案例：`RUNTIME_PACKAGES` 漏 `plugin-types`，dev 全绿、用户装完即 `ERR_MODULE_NOT_FOUND`。

环境常量、坑表（`--sleep` 不存在、容器内必须 `PORT=9102`、pid 残留、`allow-scripts`）、镜像重建流程见 skill 的 `SKILL.md`；脚本路径自动推导，从任何 cwd 调用都对。

### 修 bug 流程

修 bug 后**默认**走以下流程：

1. **编译验证**：`pnpm -r typecheck`
   - dev 态 tsx 直跑源码、**无需 build**；dist 产物只在打包部署（`pnpm pack:cli`）时才需要，见「开发环境启停与生效」。
   - 另有**按需必跑**的断言脚本（不是 typecheck 能替代的）：内核 / 事件投影 → `pnpm verify:sdk`；插件装载面 / `plugin-types` → `pnpm verify:plugins`；插件目录自检 → `pi-server plugin check <dir>`。完整测试矩阵见 `agent-testing` skill，别在这里重抄（两处各写一遍必然漂移）
2. **部署到开发环境**：按「开发环境启停与生效」执行 —— 后端改动启停 `dev:server`（启动 `pnpm dev:server` / 停止 `pnpm stop:server`），前端改动 `pnpm build:web` / `pnpm build:ide` 打包部署到 server 托管目录
3. **验证**：
   - **接口：自己验证** —— debug 接口 + curl 端到端（见 `doc/architecture/pi-agent-server_debug-testing.md`），通过才算修好
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
| 本机插件前端（仓库根 `plugins/<id>/web-src/**`） | `pnpm build:plugins:local` → `plugin reload <id>` → 浏览器刷新（平台只消费 `web/**` 产物，源码放 `web-src/`） |

注意：

- `public/web` / `public/ide` 不存在时 server 启动会跳过静态挂载 —— 首次 build 后需重启一次 server
- 改 `ide-bridge` 的 method 契约需与 Kotlin 侧同步（即使 Kotlin 代码没改）
- 只有打包态（`pi-server` CLI / `pnpm pack:cli`）才需要 dist 产物，见 `doc/architecture/pi-agent-server_packaging.md`
- **新增/改动跨包 runtime import（`@pi-agent-platform/*`）或打包脚本 → 必须跑一次 `pnpm pack:cli`**：它内置 `scripts/check-packaged.mjs` 静态自检（产物完整性 / channels manifest / manifest 指向 / 模块说明符 / 未声明依赖），dev 态永远暴露不了这类问题（tsx + pnpm symlink 会静默解析成功）；自检不过不产 tgz，启动与功能验证交给部署测试环境

## 必读

进入项目工作前：

1. [`doc/architecture/`](doc/architecture/) —— 架构总入口

## 平台代码总览

```
pi-agent-platform/                      仓库根
├── AGENTS.md                            本文件
├── doc/                                 文档（architecture）
├── plugins/                             本机自用插件（gitignored；只对本机打包实例生效，见「非 bundled 插件代码放哪」）
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
    ├── plugins/                         bundled 平台插件（进 tgz；按目录发现，不登记在 registry）
    │   ├── hello-bundled/               最小示例（server + web）
    │   ├── notifications/               收件箱 + 顶栏铃铛（R11）+ postNotification 工具
    │   ├── scheduler/                   定时任务（cron / once）+ schedule_task 工具 + skill
    │   └── webhook/                     外部事件入口 + manage_webhook 工具 + skill
    ├── packages/                        共享 types + protocol + 内核
    │   ├── core/                        内核 SDK（会话注册表 / 事件总线 / 宿主 API / 插件装载）
    │   ├── event-projection/            pi 原生事件 → 会话 DTO 投影
    │   ├── plugin-types/                插件契约类型（types-only，vendored 给插件）
    │   ├── channel-types/               5 个 IM 渠道接口（dual-target: Node + DOM）
    │   ├── ipc-protocol/                master↔worker IPC 类型
    │   ├── sdk-integration/             worker 跟 pi SDK 通信的适配层
    │   ├── shared-types/                跨包共享类型
    │   ├── api-types/                   REST API DTO
    │   └── cli/                         pi-server CLI 工具（npm install -g 后 start/stop/status/logs/plugin）
    ├── scripts/
    │   ├── build-cli.mjs                聚合 server/worker/plugins/channels/SPA → pi-server-X.Y.Z.tgz
    │   ├── build-plugins.mjs            bundled 插件 web facet（TS → 原生 ESM）
    │   ├── build-local-plugins.mjs      本机插件 web-src 子项目（作者自带 build → web/）
    │   ├── check-packaged.mjs           打包静态自检（产物 / manifest / 说明符 / 未声明依赖 / 插件 skills）
    │   ├── verify-plugins.mts           插件装载面断言（10 个扩展点 / 零副作用 / 热加载 / 账本）
    │   ├── verify-sdk.mts               内核断言（sessions.ensure 三态 / 系统信封 / streamingBehavior）
    │   ├── copy-spa.mjs                 SPA dist → server public/（build:web / build:ide 用）
    │   ├── check-mermaid.mjs            doc/ 下 mermaid 代码块真实 parse 校验
    │   └── stop-server.mjs              按端口精确停 server（pnpm stop:server）
    └── channels/                        IM 渠道包（按 manifest 动态装载）
        ├── manifest.json                启用渠道清单
        ├── shared/                      channels 内部共享 logger + registry（plain JS）
        ├── channel-wechat/              WeChat iLink ClawBot
        └── channel-qq/                  QQ Bot (p2p only MVP)
```

> **注**：`pi-agent-idea/`（IntelliJ 插件）跟 `platform/`（Node.js monorepo）**平行**，在仓库根。`platform/apps/pi-agent-ide/`（Vue SPA）是 server 通过 `/ide/` 路径静态托管的 IDE 端 UI，跟 `pi-agent-idea/` 插件配合使用——JCEF 内嵌加载 `pi-agent-ide/`，跟 Kotlin 端通过 `ide-bridge` RPC 通信。
>
> **架构详情**见 `doc/architecture/` 子模块文档（特别是 `pi-agent-idea_overview.md` + `pi-agent-idea_ide-bridge.md`）。
>
> **数据根两套互不影响**：dev（`pnpm dev:server`）用 `platform/.dev-data/`（DB / 插件库 / 注册表都在这，`rm -rf` 即归零）；
> 打包实例（`pi-server start`）用 `~/.pi/server/`。给 dev 装插件必须先把 `PI_SERVER_PLUGINS_DIR` 指过去，见「非 bundled 插件代码放哪」。

## 关键架构原则（P1）

- **5 个接口 + 严格调用方向**:见 `packages/channel-types/README.md`。主包对渠道实现零知识。
- **manifest 动态加载**:server `await import()` + web `import.meta.glob('/channels/*/src/admin/index.ts')`(Vite 限制)
- **各渠道拥有自己的表**:channels_wechat / channels_qq 由渠道包 register 时通过 `host.executeMigration()` 自管
- **session-channel-map 内存实现**:不动 sessions 表,30 分钟 idle kill worker
- **DB 表结构变更**:只改初始建表（drizzle schema + initDb）,**不写迁移逻辑**——schema 变了重建库即可,不考虑旧数据兼容
- **顶部菜单数据驱动**:Vue Router `meta.navLabel / navOrder / navIcon` 字段驱动 TopNav
- **cli 打包 + 双模式启动**:server 进程可由 npm 全局 `pi-server` 启动（`PI_SERVER_CLI=1` marker 注入绝对路径，dev 态用相对路径 fallback）

### 插件与内核（P1 之二）

- **插件是代码，不是配置**：装载点由**目录存在性**表达（`server/ worker/ extension/ web/`），行为由各目录的**默认导出**表达；`piServer.facets` 这类声明式字段已删除（不要复活第二套真相）
- **`AgentConfig.plugins` 是启用列表**：`[]` = 一个插件都不注入（**不是全开**）；`serverBuiltinTools`（逐 agent 工具白名单）已退役，工具归属改为「谁提供谁决定」——插件提供 → 插件停用即消失；平台代码实现 → inline 插件（`callServer` / `sendFileToUser`）
- **内核只留四件事**：会话管理、agent/session 配置、management（capabilities 控制面）、插件宿主。定时任务、webhook、通知已下沉为插件；IM gateway 待下沉；trigger 已退役（表还在但无代码读取）。判据：把该插件 `enabled:false` 后，平台仍能建 agent、开会话、聊完一轮
- **平台消息信封只由内核构造**（`buildSystemEnvelope` 唯一构造点）：插件只给结构化字段，不可信输入进不到标签名/属性；skill 里也**不放信封原文示例**（模型会照着伪造）
- **热加载的边界**：server 面立即生效（`plugin reload` / registry watcher）；worker、pi 扩展、插件自带 skill、`host.db.migrate` 的新表等**下次 spawn / 重启**；浏览器 facet 刷新即可
