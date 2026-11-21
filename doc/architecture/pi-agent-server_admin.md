# 平台管理（bundled 插件 `admin`）

> change: `plugin-actions-contract`（2026-11-21）。取代了已删除的 `capabilities` 控制面。

## 它是什么

`platform/plugins/admin/` 是一个**普通 bundled 插件**：只有 server facet，用
`host.actions.define()` 声明 8 个动作。没有方法级授权、没有审计表、没有允许列表 ——
启用与否只由 `agent.config.plugins` 决定。

**为什么不是"控制面"**：控制面（原 `capabilities/`）把"谁能调什么"做成了第二道闸门，
但它在结构上是假的 —— 上层 allowlist 与 `config.plugins` 重复，下层的 `write=own`
可被任意插件的 `host.agents.update` / `host.db.query` 绕过。**假的分层比没有分层更糟**，
所以整套删掉（推理见 [invariants](pi-agent-server_invariants.md)）。

## 8 个动作

| 动作 | 默认工具名 | 行为 |
|---|---|---|
| `server.status` | `admin__server_status` | `{ version, uptimeMs, nodeEnv, port, pid, workers:{active,placeholders,max,pendingCalls} }`，无凭据字段 |
| `agent.list` | `admin__agent_list` | name / workspacePath / description 组合模糊（AND，子串），返回精简 DTO |
| `agent.get` | `admin__agent_get` | 完整 `AgentDTO`（含 `config`）|
| `agent.update` | `admin__agent_update` | 局部更新（name/description/workspacePath/model/thinkingLevel/config）；**只影响未来新建的 session** |
| `session.list` | `admin__session_list` | agentId 精确 / title 模糊 / status 过滤，每项带 `workerAlive` |
| `session.get` | `admin__session_get` | 完整 `SessionDTO` + `workerAlive` |
| `session.update` | `admin__session_update` | model/thinkingLevel **即时**（IPC+DB）、title 走共享改名语义、`config.*` 只写 DB（下次 spawn）|
| `session.restart` | `admin__session_restart` | kill → 重建并复用 `piSessionPath`；渠道映射与 sessions 行不动；**busy 时拒**（不 kill）|

四个投影全开：

| 面 | 怎么用 | 说明 |
|---|---|---|
| reverse | `<id>.<action>`（`admin.session.restart` …） | 工具经这条回到 handler |
| service | `host.services.call('admin.session.list', {})` | 别的插件的 server facet 可调 |
| tool | `admin__*`（`exposure: 'deferred'`，`namespace: admin`） | 模型经 `tool_search` 激活；没开 `tool_search` 时平台 spawn 会 warn |
| http | `POST /api/p/admin/<path>` | 全局开关默认关（`PI_SERVER_ACTION_HTTP=1` 才可达）|

`scope: 'public'` 是刻意的：管理是**跨插件**能力，`scheduler` 查会话状态不该先变成 `admin` 的 owner。

## 行为实现在内核宿主面，不在插件里

插件自己拼不出来（跨 worker + DB 双写、kill+respawn），所以这些是内核提供的**受控方法**：

| host | 作用 |
|---|---|
| `sessions.detail(id)` / `sessions.find(filter)` | 完整会话行 + `workerAlive` |
| `sessions.update(id, patch)` | model/thinkingLevel 即时（worker 活着时 IPC+DB）、title 走 `renameSession`、config 只写 DB |
| `sessions.restart(id)` | busy 检查 → kill → `sessionRegistry().getOrCreate` 复用历史 |
| `lifecycle.runtime()` | 运行态**快照**（版本/uptime/端口/池统计）—— 数据不是句柄 |

**没有 `host.workerPool`**：插件要的是"现在几个 worker 在跑"，不是"能 kill 谁"。

## 审计 = 结构化日志

每个 handler 记一条 pino：`callerSessionId` / `callerPluginId` / `callerKind` / `target` / 结果 / 错误类别。
不落表 —— **会话历史本身就是审计**（调用也出现在调用方会话里）。

## 验收路径

```
GET  /api/runtime/actions              # 8 条 admin.*，scope=public / 四投影
GET  /api/runtime/methods              # reverse 表里带 reach=public
GET  /api/plugins/admin/extensions     # actions 切片 8 条 + interop 8 个 service
curl -X POST :3000/api/p/admin/server/status    # 开关关→404；开→真数据
```

模型侧：会话 `builtinTools` 含 `tool_search` 时，`admin__server_status` 可被搜到并调用（已实测：
工具 → 反向方法 → handler → JSON 全链路）。

## 已知边界

- **HTTP 面无鉴权**（用户明确后置）：开关打开即对外可达，先别开在公网
- **拿到这 8 个工具的 agent 能给自己加插件**（自我扩权）—— 这是"插件可信 + 无运行时沙箱"的直接推论，出多用户时必须重做一道门
- **`admin` 的只读状态页（web facet）还没做**：现在靠 curl 与模型调用
