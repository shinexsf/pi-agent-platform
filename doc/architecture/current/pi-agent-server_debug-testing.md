# pi-agent-server debug-testing

> **Debug / 测试接口约定与基础架构**。统一"agent 写 debug 接口辅助测试"的实践 —— 不写 unit tests，通过 HTTP 端点 + curl 验证 server 行为。

## 核心思想

**Debug 接口 = 单元测试的替代品**。Server 端不做 unit tests 也能保证质量的关键：每个新功能必须配套 **dev-only debug HTTP 端点**，agent 启动 server 后用 curl 实测验证。

**为什么 debug 接口优先 unit tests**（从 dev-journal 015-016 提炼）：

| 对比维度 | Unit tests | Debug 接口 + curl |
|---|---|---|
| **Mock 真实度** | 必然 mock，**mock 行为 ≠ 真实行为** | 跑真实 server + 真实 pi SDK + 真实 LLM |
| **Bug 复现** | 重写复现代码，引入偏差 | 跑真实流程，**直接看 stderrTail** 抓异常 |
| **回归覆盖** | 写用例时已经预设了"什么是对的" | 端点返回完整状态，**意外行为也能发现** |
| **跨语言/跨进程** | mock 边界，边界本身就是 bug 源 | 走真实 IPC / 真实 SSE / 真实 worker 子进程 |
| **维护成本** | 每次 refactor 都要重写 mock | 端点跟 server 一起演化，**端点签名变了实测就知道** |
| **历史代价** | 016 修 customPrompt bug 时 unit tests 帮不上忙（mock SDK 不会触发 silent drop）；debug 接口 + curl 端到端 5 分钟定位 | 同左 |

**显式约定**（写进 AGENTS.md 也行，但本文件是详细规范）：

> **新功能 / 新端点 / 新 RPC / 重大 bug 修复 → 必须配套 dev-only debug 接口**，用 curl 端到端验证。否则不算"完成"。

## 现有 debug 设施盘点

### Server `/debug/*`（仅 dev 模式挂载）

mount 在 `apps/pi-agent-server/src/index.ts:81`，`config.isDev = nodeEnv !== 'production'` 时启用：

| 端点 | 返回 | 用途 |
|---|---|---|
| `GET /debug/health` | `{uptime, isDev, activeSessions, activeWorkers}` | server 进程状态、当前 dev/prod 模式 |
| `GET /debug/sessions` | `{sessions: SessionDTO[], workers: WorkerSummary[]}` | 全部 session + 全部 worker |
| `GET /debug/sessions/:id` | `{session, worker: {workerPid, ready, stderrTail, pendingCalls} \| null}` | 单 session + worker 元数据 + **最近 100 段 stderr**（关键排查点）|
| `GET /debug/workers` | `{workers: WorkerSummary[]}` | 仅 workers |
| `GET /debug/db?sql=...` | `{rows: any[]}` | **直接执行 SQL**（Drizzle `sql.raw`，仅 dev）|

**关键点**：`stderrTail` 是 worker 子进程 `child.stderr.on('data')` 收集的最后 100 段 chunk（`worker-pool.ts:177-185`）。worker 端任何 `console.error` 都会进这里。

### IM Gateway `/api/im/debug/*`（IM 渠道层）

mount 在 `apps/pi-agent-server/src/im-gateway/routes/im-gateway.ts`：

| 端点 | 返回 | 用途 |
|---|---|---|
| `GET /api/im/debug/state` | `{uptime, loadedTypes, sessions: SessionChannelMeta[], adapters: AdapterStatus[], qqNotified: string[]}` | IM gateway 完整状态：已加载渠道、活跃 session-channel 映射、各 adapter 状态、QQ 群 fast-fail 已通知列表 |
| `GET /api/im/debug/logs` | SSE stream | 渠道日志实时流（调试群消息 routing 时用）|

### 生产可用但承载 debug 能力的端点

| 端点 | 来源 | Debug 用途 |
|---|---|---|
| `GET /api/sessions/:id/context` | http-api | 含 `systemPrompt: {text, length, source}` 字段（016+）—— **直接看 model 看到的 system prompt** |
| `GET /api/sessions/:id/messages` | http-api | master 直接读 jsonl 文件（不走 IPC），**看 history 持久化** |
| `GET /api/sessions/:id/events` | events router | SSE 流，**看实时事件** |
| `POST /api/sessions/:id/prompt` | http-api | 触发 prompt + spawnAndCreate |

### Worker IPC（已加的 debug 能力）

`packages/ipc-protocol/src/index.ts:14-26` 暴露的 `WorkerMethod`：

```
'createSession' | 'prompt' | 'abort' | 'setModel' | 'setThinkingLevel' | 'setTools'
| 'listCommands' | 'dispatchCommand' | 'listAvailableModels' | 'compact'
| 'getContextUsage' | 'getSystemPrompt'  ← 016 加的
```

每个都对应 worker 暴露给 master 的一个能力。`getSystemPrompt` 是 016 修 silent drop bug 时加的——之前所有 prompt 相关状态都通过 `cacheSystemPrompt()` 缓存到 `WorkerEntry.systemPrompt` 字段，master 通过 `GET /:id/context.systemPrompt` 一次性返回。

## 端点设计原则

### 1. 端点路径：`/debug/<area>/<resource>` 格式

- server 层：`/debug/<resource>`（5 个已有端点都是）
- 子模块层：`/api/<module>/debug/<resource>`（IM gateway 用 `/api/im/debug/*`）
- **不用** `/api/<resource>/debug`（会污染生产 API 命名空间）

### 2. 端点返回**完整状态**而不是分页

参考 010 经验：`/api/im/debug/state` 一次性返回 session map + adapters + QQ notified set，**不让 caller 再发请求拼**。`/debug/db?sql=...` 直接返回所有 rows。

**反例**：`GET /api/sessions?page=1&pageSize=20`（生产 API 该分页）。**debug 端点永远一次性返回**。

### 3. dev-only gating

```ts
// apps/pi-agent-server/src/index.ts:80-86
if (config.isDev) {
    app.route('/debug', createDebugRouter(workerPool, sessionRepo, db));
    console.log('[server] debug routes mounted at /debug');
} else {
    console.log('[server] debug routes disabled (production mode)');
}
```

**不要**在生产 server 上挂 debug 端点（即使有 auth）。**约定**：dev 才挂；prod 即使有 `NODE_ENV=development` 也别开。

### 4. 不影响主路径性能

016 经验：systemPrompt 是 10K+ 字符，每次 `GET /:id/context` 都 IPC 拉一遍会拖慢上下文加载。**约定**：大字段必须在 worker spawn 完成后立即 `cacheXxx()` 缓存到 `WorkerEntry`，`/:id/context` 从 entry 读，不走 IPC。

```ts
// apps/pi-agent-server/src/worker-pool.ts:60-65 + 425-444
export interface WorkerEntry {
  // ...
  /** Cached system prompt (set after createSession IPC returns). Avoids re-fetching the
   *  full system prompt string over IPC for every `GET /:id/context` call. */
  systemPrompt?: { text: string; length: number; source: 'override' | 'default' };
}

setSystemPrompt(sessionId, systemPrompt): void { /* cache on entry */ }
```

**模式**：worker `createSession` 之后 → 调 `cacheXxx()` → entry.xxx 字段立即可用 → debug / 业务端点直接读 entry。

### 5. debug 端点不写 unit tests

**约定**：debug 端点本身**不写** unit tests。原因：

- 它的价值是"真实环境"的可观测性，mock 后失去意义
- 它用到的数据源（DB / child_process / pi SDK）就是要测的
- 加 unit test 反而是负担

**要测**：debug 端点**通过 curl 验证**——启动 server → curl → 看 response。

## 新增 debug 端点的规范

按以下 6 步：

1. **判断放哪**：
   - 全局 server 状态（workers / sessions / DB）→ `apps/pi-agent-server/src/routes/debug.ts` 的 `createDebugRouter`
   - 子模块内部状态（IM gateway state、channel adapter 状态）→ 子模块自己的 `routes/<sub>.ts` + `createXxxDebugRouter`
2. **路径命名**：`/debug/<area>/<resource>` 或 `/api/<module>/debug/<resource>`
3. **返回完整状态**：不分页，**一次性返回所有相关字段**（caller 一次看全）
4. **dev-only gating**：跟全局 `/debug` 一样的 `config.isDev` 判断
5. **大字段缓存到 entry**：超过 1KB 的字段（如 systemPrompt）必须在 spawn 时缓存到 entry，不走 IPC
6. **写 dev-journal**：在 `doc/dev-journal/YYYY-MM-DD_<name>.md` 记录端点路径、返回结构、验证步骤

**模板**：

```ts
// apps/pi-agent-server/src/routes/debug.ts 或子模块 routes/<sub>.ts
router.get('/<resource>', (c) => {
  return c.json({
    // 完整状态（不分页）
    foo: ...,
    bar: ...,
  });
});
```

## 端点清单（当前）

### server debug

- `GET /debug/health`
- `GET /debug/sessions`
- `GET /debug/sessions/:id`
- `GET /debug/workers`
- `GET /debug/db?sql=...`

### IM gateway debug

- `GET /api/im/debug/state`
- `GET /api/im/debug/logs` (SSE)

### 生产可用但承载 debug 能力

- `GET /api/sessions/:id/context` (`systemPrompt` 字段)
- `GET /api/sessions/:id/messages`
- `GET /api/sessions/:id/events` (SSE)
- `POST /api/sessions/:id/prompt`

### Worker IPC

- `getSystemPrompt` (016+)

## 使用方法（典型流程）

### 场景 A：验证 worker 启动 + createSession 正常

```bash
# 1. 启动 server
pnpm --filter pi-agent-server dev

# 2. 创建 placeholder session
SESSION=$(curl -s -X POST http://localhost:3000/api/sessions/agents/$AGENT_ID | jq -r .sessionId)

# 3. 看 worker 状态
curl -s http://localhost:3000/debug/sessions/$SESSION | jq

# 4. 看 system prompt 实际下发内容（016+）
curl -s http://localhost:3000/api/sessions/$SESSION/context | jq .systemPrompt

# 5. 发 prompt 测端到端
curl -s -X POST http://localhost:3000/api/sessions/$SESSION/prompt \
  -H "Content-Type: application/json" \
  -d "{\"agentId\":\"$AGENT_ID\",\"message\":\"hi\"}"
sleep 5
curl -s http://localhost:3000/api/sessions/$SESSION/messages | jq
```

### 场景 B：worker 抛异常时排查

```bash
# 1. worker stderrTail 抓 console.error
curl -s http://localhost:3000/debug/sessions/$SESSION | jq .worker.stderrTail

# 2. 如果 error 在 worker 代码深处 + 不知道哪一行
#    → 在 worker code 加 console.error(...)
#    → 重启 server
#    → 重新 spawn session 触发
#    → 再 curl /debug/sessions/:id 看 stderrTail
```

### 场景 C：debug DB schema 变更

```bash
# 1. schema 改动后想知道 DB 实际存的字段
curl -s "http://localhost:3000/debug/db?sql=SELECT%20*%20FROM%20agents%20WHERE%20id%3D'$ID'" | jq
```

### 场景 D：IM gateway 内部状态

```bash
# 1. 看已加载的渠道
curl -s http://localhost:3000/api/im/debug/state | jq .loadedTypes

# 2. 看 session-channel 映射
curl -s http://localhost:3000/api/im/debug/state | jq .sessions

# 3. 看 QQ 群 fast-fail 已通知列表
curl -s http://localhost:3000/api/im/debug/state | jq .qqNotified
```

## 禁止事项

- ❌ **不要在生产 server 挂 debug 端点**（即使有 auth）——`config.isDev` gating 是 hard rule
- ❌ **不要给 debug 端点写 unit tests**（mock 失去意义；改用 curl 端到端）
- ❌ **不要把大字段（>1KB）每次 IPC 拉**——必须 cache 到 `WorkerEntry`
- ❌ **不要把 debug 端点混入生产 API 命名空间**（`/api/debug/*` 之类的）
- ❌ **不要让 debug 端点分页**（一次性返回完整状态，caller 自己挑）
- ❌ **不要跳过 dev-journal 记录**（即使简单端点也要写一条，方便后人复用模式）

## 历史决策

- [changelog 007: 接入真实 pi SDK](./changelog/2026-08-19_007-real-pi-sdk.md) —— `/debug/health` `/debug/sessions` `/debug/workers` 初版（5 个端点，2026-08-19）
- [changelog 012: IM Gateway 架构设计](./changelog/2026-08-26_im-gateway-design.md) —— `/api/im/debug/state` 初版（2026-08-26）
- [changelog 013: worker 接管 systemPrompt + debug 接口](./changelog/2026-08-30_013-worker-system-prompt-takeover.md) —— `/api/sessions/:id/context.systemPrompt` + `cacheSystemPrompt` + `WorkerEntry.systemPrompt` 缓存模式（2026-08-30）
- [changelog 014: debug-testing 架构规范](./changelog/2026-08-30_014-debug-testing.md) —— 本规范（2026-08-30）

## 相关 dev-journal

- [dev-journal 010: IM Gateway 调通](../dev-journal/2026-08-28_im-gateway-debug-and-real-flow.md) —— "debug 接口是开发期必备 — 比每次手动改 server 状态验证快很多"
- [dev-journal 015: worker 不加载 AGENTS.md](../dev-journal/2026-08-29_worker-agents-md-reload.md) —— "debug 接口盲区" 引出 016
- [dev-journal 016: worker 接管 systemPrompt + debug 接口](../dev-journal/2026-08-30_custom-systemprompt-takeover.md) —— `/:id/context.systemPrompt` debug 接口设计

## 关联决策