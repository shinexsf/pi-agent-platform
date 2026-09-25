# pi-agent-server capabilities

> Agent → 宿主 server 的管理能力：`callServer` meta-tool + master 侧能力控制面。
> 加 / 下线能力只动控制面注册表一处，worker 与 IPC 协议零改动。

## 总览

```
┌──────────────────────── worker（session 创建时）────────────────────────┐
│  RuntimeConfig.capabilityIndex（master 下发：按该 session 有效授权过滤）│
│        ↓ 拼进 description                                               │
│  ToolDefinition: callServer  { method: string, params?: object }        │
│    promptSnippet / promptGuidelines → system prompt                      │
│    execute → callMaster('invokeCapability', [method, params])            │
└────────────────────────────────────┬─────────────────────────────────────┘
                                     │ reverse-call IPC（30s 超时）
┌────────────────────────────────────▼─────────────────────────────────────┐
│ master：capabilities/ 控制面（唯一收口，index.ts 启动时注册一次）         │
│                                                                          │
│  dispatch（统一入口，dev-only /debug/capabilities/invoke 也走这条路径）  │
│   1. 解析 ctx（sessionId → agentId：sessions 行优先，placeholder          │
│      无 row → WorkerEntry.agentId）                                      │
│   2. 内置方法 list / detail → 内容按授权过滤（detail 未授权拒绝）        │
│   3. 业务方法：方法存在？ → 授权（双道闸）→ handler → pino 审计          │
│   4. 未知方法错误附「授权范围内」可用方法列表                             │
│                                                                          │
│  registry.ts   注册表（唯一事实源）+ 授权解析共享函数                    │
│  authorize.ts  双道闸 + CapabilityDeniedError + 固定 own 安全网          │
│  audit.ts      每次调用一条结构化审计（ok/denied/unknown/error 四态）    │
│  handlers/     server.ts | agent.ts | session.ts                         │
└──────────────────────────────────────────────────────────────────────────┘
```

## 三道配置（互不混淆）

| 字段（`AgentConfig`） | 管什么 | 生效层 |
|---|---|---|
| `builtinTools` | 7 个 pi 内置工具白名单（read/write/edit/bash/grep/find/ls），null=全开 | worker `setActiveToolsByName` |
| `serverBuiltinTools` | server 侧工具注入白名单（`sendFileToUser` / `callServer`），**未配置 = `['sendFileToUser']`（callServer 默认关）**，[]=全关 | worker customTools 注入 = prompt 可见性 |
| `capabilities` | `callServer` 方法级授权：**未配置 = opt-in 无任何方法权限**，[]=全禁，数组=精确白名单 | master 控制面 dispatch 强制校验 |

三字段都在 `AgentConfig` JSON 列（agents / sessions 共用），加字段零迁移。全局 `~/.pi/server/config.json` **只含默认工具开关**（`defaultServerBuiltinTools` 等 default* 字段），**不存任何 capabilities 策略**。

## 授权模型（双道闸 + 快照语义）

- **道闸 1（prompt 层）**：`serverBuiltinTools` 决定 `callServer` 注不注入——模型看不见工具。
- **道闸 2（强制层，信任边界在 master）**：dispatch 时校验
  1. **显式 allowlist**（唯一授权来源）：`capabilities` 未配置 → 拒（错误提示 opt-in）；`[]` → 全禁；数组 → 白名单外拒。
  2. **固定 own 安全网（硬编码，不可配置）**：read=`all`（跨 agent 读可见）、write=`own`——`scoped` 写能力目标不属于调用方 agent/session 行即拒；归属解析不到 fail closed。
- **session 快照语义**：授权读取 = session 行 config **有 `capabilities` key**（数组或显式 null）→ 用 session 的；**缺 key**（存量 row，未快照过）→ 回落 agent 行。`null`（显式未授权）≠ `undefined`（没快照过）。
- **可见性 = 强制性**：`resolveAllowedCapabilityMethods` / `resolveEffectiveCapabilities`（registry 导出）被**五处共享**——authorize 判定、spawn 时 description 索引过滤、`list` 返回内容、`detail` 可查性、未知方法错误的可用列表。改授权语义只改一处。

## v1 能力清单（module 分组）

| module | 方法 | access / scoped | 生效时机 |
|---|---|---|---|
| server | `status` | read / — | 即时（config + workerPool 统计，无凭据） |
| agent | `list`（name/workspacePath/description 组合模糊）、`get` | read（get scoped） | 即时（内存过滤） |
| agent | `update` | write / scoped | **只影响未来 session**（完全快照） |
| session | `list`（agentId 精确 + title 模糊 + status）、`get` | read（get scoped） | 即时 |
| session | `update` | write / scoped | model/thinking=即时 IPC+DB；title=改名同步；**config.*=下次 spawn** |
| session | `restart` | write / scoped | kill + 复用 piSessionPath 重建；busy 拒、placeholder 404；**sessions 行与 session-channel-map 不动** |
| channel / config | （占位空组） | — | 注册即显示 |

内置方法（不参与 allowlist 调用拦截，内容按授权收敛）：

- `list { module? }` — 按 server/agent/session/channel/config 分组返回**已授权**业务能力
- `detail { method }` — 单能力完整 spec（paramsSchema + returns 含生效时机标注）；**未授权方法拒绝**

`session.update` 的 title 走共享 `services/session-ops.ts`（`renameSession`，HTTP 三入口与控制面同一实现）。

## 端点

| 路径 | 模式 | 用途 |
|---|---|---|
| `GET /api/capabilities` | 正式 | 只读能力元数据（method/module/access/scoped/summary）——WebUI 勾选列表唯一事实源，前端不硬编码 |
| `GET /debug/capabilities[?agentId=]` | dev-only | 完整状态：固定策略 + 注册表分组 + agent 字段解析 |
| `POST /debug/capabilities/invoke` | dev-only | synthetic ctx 走**真实 dispatch** 路径——授权矩阵 L1 测试入口（不烧 LLM token） |

两者均在组合根 `if (config.isDev)` 内 dynamic import（debug 三约束），`/debug/capabilities` 与 `/debug/*` 一起挂载。

## WebUI（三处）

1. **Agent 编辑**：Resources 区域内 `Server Builtin Tools` 组（三态：默认/勾选/清空）；Resources **外**独立 `Capabilities` 区（随 callServer 启用联动显隐，module 分组勾选 + 全选/清空，未配置显示"未授权"）。
2. **Session 编辑**：同款两块；capabilities 为 session 快照级——缺 key 的存量会话展示并继承 agent 当前值，**保存即固化**（不回写 agent），提示下次 spawn 生效。
3. **配置 → 默认设置**：`defaultServerBuiltinTools` 勾选（未配置时 seed 内置默认，如实反映生效值）。

## 注入到 prompt 的文本（两半）

- **systemPrompt**：`Available tools` 段一行（`- callServer: <promptSnippet>`，不带工具名前缀——pi 拼接自带）+ `Guidelines` 段的 promptGuidelines 逐行。
- **tool description**（tools 数组，不占 system prompt 长度）：`Available methods (authorized for this session)` 按授权过滤的方法清单（method + access/scoped + 一句话 summary）+ Builtins 使用说明 + 未知方法回退说明。

## 关键边界

| 谁负责 | |
|---|---|
| **master 控制面** | 注册、分发、授权（唯一强制点）、审计、能力索引下发 |
| **worker** | 只按 `serverBuiltinTools` 注入工具、把索引拼进 description、转发调用——**不做任何授权判断** |
| **AgentConfig（session 快照）** | 工具开关与方法授权的唯一配置来源；全局 config.json 只兜工具默认 |

## 相关文档

- [`pi-agent-server_ipc.md`](pi-agent-server_ipc.md) —— `invokeCapability` 反向调用协议
- [`pi-agent-server_worker-pool.md`](pi-agent-server_worker-pool.md) —— 反向调用分发 + `WorkerEntry.agentId`
- [`pi-agent-server_session-lifecycle.md`](pi-agent-server_session-lifecycle.md) —— respawn 配置读取（session 行优先）+ 完全快照语义
- [`pi-agent-server_db-schema.md`](pi-agent-server_db-schema.md) —— `AgentConfig` 字段
- [`pi-agent-server_http-api.md`](pi-agent-server_http-api.md) —— `GET /api/capabilities`
- [`pi-agent-server_debug-testing.md`](pi-agent-server_debug-testing.md) —— `/debug/capabilities*` 端点规范
