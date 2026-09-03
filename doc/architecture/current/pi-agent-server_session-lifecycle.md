# pi-agent-server session-lifecycle

> Session 生命周期。定义 session 何时创建、销毁、配置管理。
> v2：placeholder 即 spawn + 统一 context 端点 + worker pool 上限 20 + LRU + 删 active 自动超时（详见 `doc/architecture/changelog/` README）。

## 状态机

```
[不存在]              ← 客户端无 sessionId
  ↓ 客户端调 POST /api/sessions/agents/:agentId
  ↓ master: 生成 sessionId + spawn placeholder worker + 调 listCommands/listAvailableModels
  ↓ 返 { sessionId, commands[], models[] }（**sessions 表未写**）
[占位 + 有 worker]    ← sessionId 已颁发 + worker 已起 + DB 无 row
  ↓ 5 分钟内未发第一条消息 → scanner: kill placeholder worker（hasRow=false）
  ↓ placeholder sessionId 自动作废（client 持有）
  ↓
  ↓ 客户端发 POST /api/sessions/:id/prompt
  ↓ master: spawnAndCreate → INSERT sessions + 调 markRowWritten
[active]              ← DB 有 row + worker alive（hasRow=true）
  ↓ 用户/IDE 关 tab → POST /:id/close → kill worker（sessions row 保留，DB 不改 status）
  ↓ worker 崩溃 → master: worker.on('exit') → 清理 Map（DB 不改 status）
  ↓ 注意：**active session 不会自动超时**（scanner 只杀 hasRow=false）
  ↓
  ↓ 用户消息到达（worker 可能已被 close 或 crash）
  ↓ master: spawnAndCreate → worker 不存在时重建（复用 piSessionPath）
[active]              ← 重建后回到 active
```

**关键变化**（vs v1）：
- **占位不是无状态过渡**——worker 已经 spawn，可以即时提供 commands/models
- **`status='archived'` 字段不再被自动写**——worker pool 是 session alive 的 source of truth
- **active session 不自动超时**——生命周期完全由调用方管理（IDE 关 tab / Web 手动接口）

## 创建：两阶段

### 阶段 1：占位（生成 sessionId + spawn worker，不写表）

```typescript
// POST /api/sessions/agents/:agentId
async function createPlaceholder(agentId: string): Promise<PlaceholderSessionResponse> {
  const agent = agentRepo.getOrThrow(agentId);
  if (!existsSync(agent.workspacePath)) throw 400;

  const sessionId = sessionRepo.newSessionId();  // UUID
  await spawnPlaceholder(sessionId, agent, workerPool);  // spawn worker + createSession
  const [commands, models] = await Promise.all([
    workerPool.call<SlashCommandDTO[]>(sessionId, 'listCommands', []),
    workerPool.call<ModelInfo[]>(sessionId, 'listAvailableModels', []),
  ]);
  return { sessionId, agentId, commands, models };
}
```

**为什么占位也 spawn worker**：
- 用户开 tab 后 slash menu 立即可用（看到 `.pi/prompts/*.md`、`.pi/skills/*/SKILL.md`、extension commands）
- 用户从模型下拉选 model 时看到完整列表
- **代价**：每次开 tab 触发 `createAgentSession`（读 models.json + 扫 cwd `.pi/` + 加载 packages）—— 一般 < 200ms

### 阶段 2：实际创建（第一条 prompt 时写 sessions 表）

```typescript
// POST /api/sessions/:id/prompt
async function handlePrompt(sessionId: string, message: string, body: PromptRequest) {
  const agent = agentRepo.getOrThrow(body.agentId);
  const existing = sessionRepo.get(sessionId);

  if (existing) {
    // archived 复活 / 重启后回到 active
    if (!workerPool.has(sessionId)) {
      await spawnAndCreate(sessionId, agent, sessionRepo, workerPool, existing.piSessionPath);
    }
    sessionRepo.update(sessionId, {});  // bump lastActiveAt
  } else {
    // 占位 + worker 已存在（被 POST /agents/:agentId 创建）→ 复用 worker + 写 row
    await spawnAndCreate(sessionId, agent, sessionRepo, workerPool);
  }

  await workerPool.call(sessionId, 'prompt', [message, body.images, body.streamingBehavior]);
  sessionRepo.update(sessionId, {});

  // send() 完成后 Vue 端 loadContext() 拿 hasRow=true 的 session field
}
```

**`spawnAndCreate` 关键职责**：
- `workerPool.spawn(sessionId, workspacePath)`（LRU 可能在 spawn 内部触发）
- `workerPool.call(sessionId, 'createSession', [runtimeConfig, sessionId, existingSessionPath])`
- 写/更新 `sessions` 表（`createFromAgent` or `update({model})`）
- **`workerPool.markRowWritten(sessionId)`**——`hasRow` 设为 true，从 placeholder 变 active
- **`cacheSystemPrompt(sessionId, workerPool)`**（见下）—— fetch `getSystemPrompt` IPC、缓存到 WorkerEntry，让 `GET /:id/context` 能返回完整 systemPrompt 文本

**`spawnPlaceholder` 关键职责**（同路径独立调）：
- `workerPool.spawn(sessionId, workspacePath)`
- `workerPool.call(sessionId, 'createSession', [...])`
- 缓存 `piSessionPath` / `model` / `thinkingLevel` / `systemPrompt` 到 WorkerEntry
- **不调** `markRowWritten`（保持 `hasRow=false`）

### systemPrompt 拼接职责（2026-08-30+）

**Worker 不再 100% 依赖 pi SDK 拼接 systemPrompt**。createSession 之后，如果 `config.systemPrompt` 非空，worker 用 `_systemPromptOverride` 接管拼接：

```
[worker createSession]
  ↓
[pi SDK buildSystemPrompt({ customPrompt: agent.systemPrompt })]
  ↓ customPrompt 分支返回 prompt_A (default-build)
[worker 检查 config.systemPrompt?.trim()]
  ↓ 非空
[拼接 prompt_B = userPrompt + suffix]
  suffix 顺序: Available tools → "In addition to..." → tool promptGuidelines
             → appendSection → <project_context> → <available_skills> → cwd
[realSession._systemPromptOverride = prompt_B]
  ↓
[每次 LLM 调用: this._systemPromptOverride ?? this._baseSystemPrompt → prompt_B]
```

- customPrompt 路径：保留 Available tools / "In addition to..." / tool promptGuidelines（避免 model 乱调用工具）
- default 路径：走 pi SDK 原 default prompt（含 Pi doc / Role def / 硬编码 Guidelines），不动
- 详细规格见 [`worker-system-prompt-customization` spec](../specs/worker-system-prompt-customization/spec.md)

**两套 spawnPlaceholder/spawnAndCreate 实现的注意**：worker 当前架构下 `im-gateway/session-bridge.ts` 和 `routes/sessions.ts` **各自有本地实现**（IM 渠道 / IDE+web 端分别走）。改 systemPrompt 拼接或加 cacheSystemPrompt 时，**两处都要改**——否则一边的 session 不缓存 systemPrompt，`GET /:id/context` 返回 null。

**两种场景走同一路径**：
- 占位 sessionId + 第一条 prompt → INSERT + markRowWritten
- archived session + 用户消息 → 已存在 + worker 死 → 重建（复用 piSessionPath）

## 销毁：调用方管理

```typescript
// 用户关 tab（IDE 端）
async function closeSession(sessionId: string) {
  if (workerPool.has(sessionId)) {
    await workerPool.kill(sessionId, 'tab-closed');
  }
  // NOTE: session row 保留在 DB（status='active'），用户可以从历史重开
}

// 用户主动归档（web 端或 IDE）
async function archiveSession(sessionId: string) {
  if (workerPool.has(sessionId)) await workerPool.kill(sessionId, 'archive');
  sessionRepo.archive(sessionId);  // status='archived'（手动 API 才写）
}

// scanner: placeholder 超时自动清理
async function scanPlaceholderTimeouts() {
  const now = Date.now();
  for (const entry of workerPool.list()) {  // snapshot 避免迭代中修改
    if (!entry.hasRow && (now - entry.spawnTime) > config.placeholderTimeoutMs) {
      await workerPool.kill(entry.sessionId, 'placeholder-timeout');
    }
  }
}
```

**触发销毁的场景**：
- **Placeholder 5 分钟无活动**（默认 `PLACEHOLDER_TIMEOUT_MINUTES=5`）—— scanner 自动清理
- **用户/IDE 关 tab** → `POST /:id/close` 立即杀 worker
- **用户主动归档** → `POST /:id/archive` + DB status='archived'
- **Master 退出** → OS 自动 kill worker 子进程
- ~~**Active session 超时**~~ —— **已删除**（OQ-D2 演化）

## 配置管理：完全快照

**创建时**：INSERT sessions，从 agent 表**完整复制**配置字段到 sessions 对应字段。

**session 内修改**：更新 sessions 对应字段（**不写回** agent 表）。

```typescript
async function setSessionModel(sessionId: string, provider: string, modelId: string) {
  await workerPool.call(sessionId, 'setModel', [provider, modelId]);
  sessionRepo.update(sessionId, { model: `${provider}/${modelId}` });
}
```

**session 恢复**：完全读 sessions 表，**不读 agent 表**。

## sessionId 由 master 生成

### 阶段 1：占位生成 + worker spawn

```typescript
POST /api/sessions/agents/:agentId
// Request: (空)
Response 200: { sessionId, agentId, commands[], models[] }
```

### 阶段 2：prompt（URL 携带）

```typescript
POST /api/sessions/:sessionId/prompt
{ message, images?, streamingBehavior?, agentId }
// Response 200: { sessionId, workerPid }
```

## 错误处理：走 SSE chat 流

worker 失败 → 错误事件 → IPC → master SSE → 前端 chat 消息气泡。

**不改变 session 状态**。用户看到错误信息后自己修（如切模型重试）。

## session 配置独立于 agent

| 维度 | agent 表 | sessions 表 |
|---|---|---|
| 创建时 | 用户配置 agent | 复制 agent 字段 |
| 修改 agent 配置 | UPDATE agents | **不影响 sessions** |
| 修改 session 配置 | **不影响 agent** | UPDATE sessions |
| session 恢复 | 不读 | 读 sessions |

## 与 Worker Pool 关系

| session 状态 | Worker Pool entry | hasRow |
|---|---|---|
| 占位（开 tab 后）| ✅ alive | `false` |
| Active（发过第一条消息）| ✅ alive | `true` |
| Placeholder 超时被 scanner 杀 | ❌ removed | n/a |
| IDE 关 tab | ❌ removed | `true`（row 保留，DB 不改）|
| Active 被 LRU 回收（容量满）| ❌ removed | `true`（row 保留）|

## 与 IM 网关关系

IM 网关创建的 session **不污染 `sessions` 表** — sessions 表本身不区分 web / IDE / IM 来源。IM 网关**自己维护** `Map<sessionId, SessionMeta>` 用于 idle timeout 跟踪。

IM 网关与本 session-lifecycle 的交互点：
- 共享 `session-bridge.ts` 抽象（routes/sessions.ts 和 IM 网关都调用，避免重复）
- IM 网关的 `routeAndSpawn` 直接调 `workerPool.spawn()` / `spawnAndCreate()`，不走本文件描述的 HTTP API
- IM 网关**不**写 `status='archived'`（即使 worker 被 kill）— sessions 表保持 status='active'，IM 网关自己跟踪会话生命周期
- IM session idle timeout（30 分钟）由 IM 网关自己的扫描器处理，不修改 server 现有的 placeholder scanner

IM 网关的细节详见 [`pi-agent-server_im-gateway.md`](pi-agent-server_im-gateway.md) 的 D16（idle timeout）和 D5（/new 命令）。

## 相关文档

- [`pi-agent-server_worker-pool.md`](pi-agent-server_worker-pool.md) —— WorkerEntry metadata + LRU + markRowWritten
- [`pi-agent-server_db-schema.md`](pi-agent-server_db-schema.md) —— sessions 表字段
- [`pi-agent-server_http-api.md`](pi-agent-server_http-api.md) —— 端点定义
- [`pi-agent-server_ipc.md`](pi-agent-server_ipc.md) —— setModel 等调用的实现