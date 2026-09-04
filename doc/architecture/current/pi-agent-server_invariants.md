# pi-agent-server invariants

> 架构层不变量（system-wide hard rules）。**不能动**，动之前必须写新架构变更并重新评审（详见 `doc/architecture/changelog/` README）。

## 进程模型

- **worker 内只跑 1 个 session**（1 worker : 1 session）
  - 改 1 worker 多 session 会破坏崩溃隔离（一 session OOM 全死）
- **master 通过 AgentSessionProxy 调 worker**
  - 绕过代理就失去协议层控制（master 直接 `worker.send()` 会破坏 message dispatch）
- **worker 进程对象不写 DB**（master 进程内 Map 管理）
  - DB 是配置层，不持久化运行时对象
  - 不能再加 `workers` 表

## Session 设计

- **session.id 直接当 pi SDK sessionId**
  - pi SDK 自动写历史到 `~/.pi/agent/sessions/<sessionId>/>`
- **session 配置完全快照**（创建时复制 agent 字段 + session 内修改不写回 agent）
  - 不能改成 merge / 动态继承（复杂度 > 价值）
- **session 生命周期独立于 agent**
  - agent 配置改了**不影响**已存在的 session
  - 反之，session 内修改也**不影响** agent
- **session 状态只有 `active` / `archived`**
  - `active` = 内存有 worker
  - `archived` = 无 worker（**超时销毁** 或 **worker 崩溃**都算 archived）
  - **不引入** `crashed` / `broken` 等额外状态
  - 区别超时 vs 崩溃：靠日志，不靠 schema

## Worker 进程管理

- **worker 崩溃 → 直接退出，不自动重启**
  - master 收到 `worker.on('exit')` → 清理内部 Map → session 标 `archived`
  - 不自动重启：避免状态错乱（worker 内部可能处于不一致状态）
- **session 恢复由用户消息触发**（懒恢复）
  - archived session 收到用户消息 → spawn 新 worker → `createAgentSession({ sessionId })` 自动加载历史
  - 不主动恢复（不浪费资源）
- **worker 进程 cwd = agent.workspacePath**（不能改成 master cwd）
  - 第三方 pi 插件可能直接读 `process.cwd()`（不走 pi SDK session cwd）
  - worker cwd = agent workspacePath → 插件拿正确目录
  - 影响 worker module 解析吗？**不**（入口文件绝对路径 / 相对 import 基于文件位置 / node_modules 向上找）
- **启动快速失败**：master spawn worker 后 **5 秒内**（默认 `WORKER_STARTUP_TIMEOUT_MS=5000`）检测 `exit code !== 0` 立刻报错
  - 5s 是经验值：启动失败通常 <1s 退出，正常 pi SDK 启动（读 `models.json` + 加载资源）需要 ~1s，留 4s 缓冲
  - 早期设计值 200ms 已被实测推翻（详见 dev-journal 014：worker env 漏注入 → 退 2 的教训）
  - 太短误报，太长上层等待过久
  - 通过 `WORKER_STARTUP_TIMEOUT_MS` 环境变量可调
- **stderr 诊断收集**：worker stderr 保留**最近 100 chunks**
  - 用于启动失败 / 运行时异常时的诊断（dump stderr）
  - 不能改大改小（影响诊断完整性 vs 内存占用）
- **优雅停止协议**：master dispose worker 用 **SIGTERM → 5 秒等待 → SIGKILL 兜底**
  - 给 pi SDK 清理时间（写历史文件、关闭连接）
  - 5 秒超时不能改：太短丢数据，太长 user 等得不耐烦

## Server 生命周期

- **master 退出 = 所有 worker 跟着退出**
  - OS 自动清理（worker 是 `child_process` 子进程）
  - 不需要显式处理
  - 不能用 detached / daemon 模式（破坏父子进程关系）

## 渠道接入

- **HTTP + SSE 走 Web / IDE 渠道**
- **渠道包自管协议**走 IM 渠道（QQ WebSocket / 微信 iLink HTTP long-poll）
  - 渠道包负责建立长连接（WebSocket / long-poll）、收发消息、媒体加解密
  - 主包不感知具体协议，只通过 `ChannelAdapter` 接口统一回调
- **pi TUI 接入方式待定**（⏸️ 不进 invariants）

## IM 网关主包零渠道知识（2026-08-26 新增）

主包（`pi-agent-server` + `pi-agent-web`）对渠道实现零知识，硬约束：

### 主包代码（src/）零渠道字面量

主包 `src/` 下 MUST NOT 出现以下字面量：

| 类别 | 禁现示例 |
|---|---|
| 渠道表名 | `channels_wechat`, `channels_qq`, `channels_qq_routes` |
| 渠道字段 | `storage_dir`, `storageDir`, `app_secret`, `appSecret`, `group_openid`, `groupOpenid` |
| 渠道 SDK | `@tencent-connect/qqbot-connector`, `@wechatbot/wechatbot`, `qq-bot-sdk`, `iLinkSDK` |
| 渠道路由字面量 | `"/api/im/wechat"`, `"/api/im/qq"`（**不在主包 src/ 出现**；主包 im-gateway 用 `router.route(\`/${type}\`, r)` 运行时按 manifest 拼接，渠道包在 `register()` 时把前缀作为参数传入）|

### 主包 package.json 零 SDK 依赖

- `apps/pi-agent-server/package.json` dependencies MUST NOT 包含任何 IM SDK
- `apps/pi-agent-web/package.json` dependencies MUST NOT 包含任何 IM SDK
- IM SDK 依赖只能在 `platform/channels/<type>/package.json`

### 主包 db/init.ts 零渠道 DDL

- `apps/pi-agent-server/src/db/init.ts` MUST NOT 包含 `CREATE TABLE channels_*` 语句
- 渠道表完全由渠道包 register 时通过 `host.executeMigration()` 创建

### 主包 routes 零渠道路由硬编码

- `apps/pi-agent-server/src/routes/` MUST NOT 有任何针对 `/api/im/<type>/*` 的硬编码路由
- 渠道路由由渠道包通过 `host.registerRoutes(prefix, honoRouter)` 动态挂载

### 加新渠道零改主包

加一个渠道包（如 Slack）需要改动的位置（验证清单）：
- `platform/channels/channel-slack/` 新增目录
- `platform/channels/manifest.json` `channels` 数组加 `"channel-slack"`
- 主包任何文件（MUST NOT）改动

**违反以上任一硬约束 = 动架构，必须写新架构变更并重新评审**（详见 `doc/architecture/changelog/` README）。

## sessionId

- **master 预生成 sessionId**
  - 客户端发 prompt 不带 sessionId
  - master 在 `INSERT sessions` 时生成
  - 客户端用 master 返回的 sessionId

## 错误处理

- **业务错误走 SSE chat 流**（不是 API 抛错）
  - worker 失败 → error event → IPC → master SSE → 前端 chat 消息气泡
  - **不改变** session 状态
  - 用户看到错误信息后自己修（如切模型重试）
- **API 参数错误** → 4xx + JSON
- **系统错误** → 5xx + JSON

## IPC 协议

- **method 字段直接是 pi SDK API 名**（`prompt` / `setModel` / `abort` / 等）
  - 不引入自定义 method 名（如 `type: 'prompt'`）
  - worker 端 method dispatch 直接调 SDK

## 不进 invariants 的项

| 项 | 状态 |
|---|---|
| worker 数量策略（固定 / 动态）| ⏸️ 暂不定 |
| worker 日志聚合 | ⏸️ 未讨论 |
| session 超时配置粒度（全局 vs per-agent）| ⏸️ 未讨论 |
| session 超时默认时长（30 分钟？）| ⏸️ 未讨论（IM 网关写死 30min，配置化后续做）|
| `sessions.status` 字段 | 🟡 废弃（不再更新，保留以兼容老 row）|
| IM 网关细节（manifest 格式 / 5 个接口定义 / 路由策略）| 详见 `pi-agent-server_im-gateway.md` |
| pi TUI 接入方式 | ⏸️ 待定 |

## 路径处理（新代码必读）

**这是最容易被忽略的坑区。所有路径相关代码必须遵循下面的规则。**

### 1. 所有写入 DB 的路径字段**必须**先 `normalizePath()`

工具：`apps/pi-agent-server/src/utils/normalize-path.ts`

规则：forward slash (`/`) + Windows 盘符小写 (`C:` → `c:`) + 去尾部 `/`

**应用点**：
- `agents.workspacePath`（repo create / update）
- `sessions.piSessionPath`（worker 返回的路径，存入前要 normalize 吗？查后补）

**禁止**：
- 直接存用户原始输入（`C:\Users\foo\workspace\`）
- 用 `path.resolve` 替换 `normalizePath`（前者跟平台相关，后者统一 forward slash）

### 2. WORKER_ENTRY 解析规则（worker-pool.ts 顶部）

**坑**：`import.meta.url` 在 `tsx` 下**不可靠**（指向 temp 位置）。`__dirname` 也是。

**正确做法**：`process.cwd()` + 多个 candidate + `existsSync` 检查：

```typescript
const candidates = [
  path.resolve(process.cwd(), '../../workers/session-worker/dist/index.js'),
  path.resolve(process.cwd(), '../../workers/session-worker/src/index.ts'),
  path.resolve(__dirname, '../../workers/session-worker/dist/index.js'),
  // ... 多个 fallback
];
for (const c of candidates) {
  if (existsSync(c)) return c;
}
throw new Error('Worker entry not found. Tried: ' + candidates.join(', '));
```

**未来加新 worker**：复制这个 pattern，**不要**用 `import.meta.url` 或单独 `__dirname`。

### 3. spawn worker 时 `cwd` 必须是 `agent.workspacePath`

**原因**：第三方 pi 插件直接读 `process.cwd()`。如果 worker cwd = master 启动目录，插件拿错目录。

**调用方式**：`workerPool.spawn(sessionId, workspacePath)` —— `workspacePath` 是 `agent.workspacePath`（已 normalize）。

**未来加新 spawn 场景**：始终传 workspacePath（即使觉得不需要）。

### 4. spawn 前**必须**校验 workspacePath 存在

**原因**：Windows `CreateProcessW` 如果 `lpCurrentDirectory` 是不存在的目录 → `ENOENT`，Node.js 报 unhandled error。

**做法**：`existsSync(agent.workspacePath)` 检查 → 不存在直接 400 错误（不触发 spawn）。

### 5. 运行时传给 fs API 时**必须** `path.resolve` / `path.normalize`

DB 存的路径是 forward slash 形式。传给 `fs.readFile` / `path.resolve` 等 native API 时用 `path.resolve(dbPath)` 转换。

**反例**：直接用 `fs.readFile('c:/Users/foo/workspace/file.txt')` —— Windows 上**应该** work（Node.js 接受 forward slash），但**不保证**所有 API 一致。

### 6. JSON config 字段**不要**存路径

`agents.config` / `sessions.config` 是 `Record<string, unknown>`。路径字段**单独存列**（如 `workspace_path`），不要塞 config 里。

**理由**：路径需要 normalize / 校验 / 索引，JSON 里查不到、规范化不了。

## 相关文档

- [`pi-agent-server_session-lifecycle.md`](pi-agent-server_session-lifecycle.md) —— session 状态机
- [`pi-agent-server_worker-pool.md`](pi-agent-server_worker-pool.md) —— worker 进程模型
- `normalizePath` 工具（路径规范化段）
- spawn cwd 段（worker cwd = agent.workspacePath）

## 相关文档

- [`pi-agent-server_session-lifecycle.md`](pi-agent-server_session-lifecycle.md) —— session 状态机
- [`pi-agent-server_worker-pool.md`](pi-agent-server_worker-pool.md) —— worker 进程模型
- [`pi-agent-server_ipc.md`](pi-agent-server_ipc.md) —— IPC 协议约束