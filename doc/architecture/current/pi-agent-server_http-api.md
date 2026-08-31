# pi-agent-server http-api

> HTTP API 路由。hono 框架。
> v2：见 `changelog/2026-08-24_012-session-lifecycle-v2.md`（统一 context 端点）

## Health

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/health` | GET | 健康检查 |

## Agent CRUD

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/agents` | GET | 列出 agents |
| `/api/agents` | POST | 创建 agent |
| `/api/agents/:id` | GET | 详情 |
| `/api/agents/:id` | POST | 更新 |
| `/api/agents/:id/delete` | POST | 删除 |

## Session CRUD

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/sessions` | GET | 列出 sessions（agentId 可选过滤）|
| `/api/sessions/:id` | GET | 详情（**保留兼容**，web 端用；新客户端用 `/context`）|
| `/api/sessions/:id` | POST | 更新（title）|
| `/api/sessions/:id/archive` | POST | 归档 |
| **`/api/sessions/:id/context`** | **GET** | **★ 统一 context 端点**（commands + models + session metadata）|

## 会话交互（核心）

| 路径 | 方法 | 用途 | sessionId 来源 |
|---|---|---|---|
| **`/api/sessions/agents/:agentId`** | **POST** | **占位 + spawn worker + 返 4 类 commands + models** | **master 生成**（UUID）|
| `/api/sessions/:id/prompt` | POST | 发消息（URL 携带 sessionId）| URL |
| `/api/sessions/:id/abort` | POST | 中断 | URL |
| `/api/sessions/:id/close` | POST | 杀 worker（IDE 关 tab） | URL |
| `/api/sessions/:id/model` | POST | 切模型 | URL |
| `/api/sessions/:id/think` | POST | 切 thinking | URL |
| `/api/sessions/:id/command` | POST | dispatch slash command | URL |
| `/api/sessions/:id/rename` | POST | 重命名 session | URL |
| **`/api/sessions/import-from-file`** | **POST** | **关联外部 pi session 文件入库**（读 .jsonl 头部拿 sessionId，snapshot agent 配置建 row；不 spawn worker）。body: `{ agentId, piSessionPath, title? }`。Idempotent（id 冲突返已存在 row） | master |
| **`/api/models`** | **GET** | **全局 model registry**（IDE Add-Agent 对话框下拉用） | master |

**两阶段流程**（v2）：
1. 客户端打开新对话 → `POST /api/sessions/agents/:agentId` → **master 生成 sessionId + spawn placeholder worker + 调 listCommands/listAvailableModels** → 返回 `{ sessionId, agentId, commands[], models[] }`（**sessions 表未写**）
2. 客户端发 prompt → `POST /api/sessions/:sessionId/prompt` → master `spawnAndCreate`（INSERT sessions + `markRowWritten`）+ 发消息

## 统一端点（v2 新增）

### `GET /api/sessions/:id/context`

合并 slash commands + 全局 models + session metadata + system prompt 为单次 fetch：

```typescript
interface SessionContextDTO {
  sessionId: string;
  hasRow: boolean;              // false = placeholder (no DB row yet)
  session: SessionDTO | null;   // null if placeholder
  commands: SlashCommandDTO[];  // 4 类：builtins + extensions + prompts + skills
  models: ModelInfo[];          // 全局可用 models（不依赖 worker）
  currentModel: { provider: string; modelId: string } | null;  // 当前 session 用的 model
  currentThinkingLevel: 'off' | 'low' | 'medium' | 'high' | null;  // 当前 thinking level
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;  // context window 使用情况
  systemPrompt: { text: string; length: number; source: 'override' | 'default' } | null;  // 完整 system prompt（2026-08-30+）
}
```

**Cases**：
| worker alive | session row | 返回 |
|---|---|---|
| ✅ | 有 / 无 | `{ ... commands, models, session, systemPrompt, ... }`（placeholder 时 session=null）|
| ❌ | 有 | 同步 respawn worker → 返回同 case 1 |
| ❌ | 无（placeholder 已被 scanner 杀）| `commands: []`、`models: [...全局]`、`session: null`（不主动重建，`systemPrompt: null`）|

**`systemPrompt` 字段说明**（2026-08-30+）：
- `source: "override"` — worker 接管拼接（agent 配置了 `system_prompt`），拼接 user prompt + Available tools + tool promptGuidelines + `<project_context>` + `<available_skills>` + cwd
- `source: "default"` — pi SDK 默认 prompt 分支（agent.systemPrompt 为空），含 Role def / 硬编码 Guidelines / Pi documentation
- `text` — 完整 system prompt 字符串
- `length` — 字符数
- `null` — 缓存未命中（worker 还没走完 createSession）

详细规格见 [`worker-system-prompt-customization` spec](../specs/worker-system-prompt-customization/spec.md)。

**已删除的端点**（合并到 context）：
- ❌ `GET /api/sessions/:id/commands`
- ⚠️ `GET /api/models`（**曾删除，2026-08-26 重新加入**——给 IDE Add-Agent 对话框下拉用；不再依赖 worker；webui 仍走 `/context`）

## 流式响应

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/sessions/:id/events` | GET | **SSE 事件流** |

## Worker（调试）

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/workers` | GET | 列出活跃 workers |
| `/api/workers/:id` | GET | worker 详情 |

## 错误约定

| 类型 | 处理 |
|---|---|
| 业务错误（model 不可用等）| **走 SSE 流**（chat 内显示），API 返回 200 |
| API 参数错误 | API 返回 400 + JSON |
| Worker pool 容量满 | API 返回 503 + `{ error, code: 'capacity_exceeded' }` |
| 系统错误 | API 返回 500 + JSON |

## SSE 协议

```
event: message_update
data: {"type":"message_update","delta":"..."}

event: message_end
data: {"type":"message_end","content":"..."}

event: tool_call
data: {"type":"tool_call","name":"read","args":{...}}

event: tool_result
data: {"type":"tool_result","output":"..."}

event: agent_end
data: {"type":"agent_end"}
```

## Request / Response 示例

```typescript
// POST /api/sessions/agents/:agentId    // 阶段 1：占位 + spawn worker
// Request: (空)
// Response 200: {
//   sessionId: "uuid",
//   agentId: "uuid",
//   commands: [ {name: "session", ...}, {name: "test-prompt", ...}, {name: "skill:test-skill", ...}, ... ],
//   models: [ {provider: "deepseek", modelId: "deepseek-v4-flash", ...}, ... ]
// }

// GET /api/sessions/:id/context
// Response 200: {
//   sessionId, hasRow, session, commands, models
// }

// POST /api/sessions/:id/prompt    // 阶段 2：发消息
// Request: { "message": "...", "agentId": "uuid", "streamingBehavior": "steer" }
// Response 200: { sessionId, workerPid }

// POST /api/sessions/:id/close    // IDE 关 tab
// Request: (空)
// Response 200: { ok: true }

// POST /api/sessions/:id/model
// Request: { provider: "deepseek", modelId: "deepseek-v4-flash" }
// Response 200: { ok: true, provider, modelId }

// POST /api/sessions/:id/command
// Request: { name: "session", args: "" }
// Response 200: { ok: true, result: { kind: "text", content: "**Session** `xxx`\n- Status: ...\n..." } }
```

## 配置环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | 3000 | HTTP 端口 |
| `DATABASE_PATH` | `./data.db` | SQLite 文件 |
| `WORKSPACE_ROOT` | `process.cwd()` | 客户端未传 workspacePath 时的默认 |
| `PI_AGENT_DIR` | `~/.pi/agent/` | pi SDK agent dir |
| `WORKER_STARTUP_TIMEOUT_MS` | 5000 | worker 启动 ready 超时 |
| **`PLACEHOLDER_TIMEOUT_MINUTES`** | **5** | placeholder worker 超时（v2 新增）|
| **`MAX_WORKERS`** | **20** | worker pool 上限（v2 新增）|
| ~~`SESSION_TIMEOUT_MINUTES`~~ | ~~30~~ | ~~**已删除**（v2 移除 active session 自动超时）~~|

## 待决

- WebSocket 协议（IM 渠道，飞书 SDK 等）
- 认证授权（v1 无）
- 分页（v1 不分页）
- 限流（v1 不做）

## 相关文档

- [`pi-agent-server_session-lifecycle.md`](pi-agent-server_session-lifecycle.md) —— session 两阶段创建 + 占位 spawn worker
- [`pi-agent-server_worker-pool.md`](pi-agent-server_worker-pool.md) —— WorkerEntry hasRow + LRU
- [`pi-agent-server_ipc.md`](pi-agent-server_ipc.md) —— SSE event 来源