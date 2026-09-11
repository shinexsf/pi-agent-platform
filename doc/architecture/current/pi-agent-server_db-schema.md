# pi-agent-server db-schema

> DB Schema。SQLite + drizzle ORM。

## agents 表

```sql
CREATE TABLE agents (
  id                    TEXT    PRIMARY KEY,
  name                  TEXT    NOT NULL,
  description           TEXT,
  workspace_path        TEXT    NOT NULL,

  -- 核心配置（平铺）
  model                 TEXT    NOT NULL,
  thinking_level        TEXT,

  -- 所有可选配置（JSON）
  config                TEXT,                 -- AgentConfig JSON

  -- 元数据
  created_at            INTEGER NOT NULL,     -- timestamp_ms
  updated_at            INTEGER NOT NULL
);
```

## sessions 表

```sql
CREATE TABLE sessions (
  id                    TEXT    PRIMARY KEY,
  agent_id              TEXT    NOT NULL REFERENCES agents(id),

  -- 核心配置（平铺，跟 agent 字段对得上）
  model                 TEXT    NOT NULL,
  thinking_level        TEXT,

  -- 所有可选配置（JSON）
  config                TEXT,                 -- AgentConfig JSON

  -- pi SDK 关联
  pi_session_path       TEXT    NOT NULL,    -- 历史消息文件绝对路径（jsonl）

  -- 状态 / 元数据
  status                TEXT    NOT NULL CHECK (status IN ('active', 'archived')),
  title                 TEXT,

  created_at            INTEGER NOT NULL,
  last_active_at        INTEGER NOT NULL
);

CREATE INDEX idx_sessions_agent_id       ON sessions(agent_id);
CREATE INDEX idx_sessions_status         ON sessions(status);
CREATE INDEX idx_sessions_last_active_at ON sessions(last_active_at);
```

## AgentConfig 接口

```typescript
interface AgentConfig {
  // 系统指令
  systemPrompt?: string;
  appendSystemPrompt?: string;

  // 内置工具控制（null = 全部启用，[] = 全部禁用）
  builtinTools?: string[];

  // 插件控制（从 settings.json 筛选）
  extensions?: string[];

  // 技能/模板控制（null = 全部，[] = 无）
  skills?: string[];
  prompts?: string[];
}
```

## TypeScript（drizzle）

```typescript
export interface Agent {
  id: string;
  name: string;
  description?: string;
  workspacePath: string;

  model: string;
  thinkingLevel?: string;
  config?: AgentConfig;

  createdAt: number;
  updatedAt: number;
}

export interface Session {
  id: string;
  agentId: string;

  model: string;
  thinkingLevel?: string;
  config?: AgentConfig;

  piSessionPath: string;
  status: 'active' | 'archived';
  title?: string;

  createdAt: number;
  lastActiveAt: number;
}
```

## 时间字段

- 用 `INTEGER` + drizzle `mode: 'timestamp_ms'`
- 自动在 JS Date ↔ epoch ms 转换
- 索引性能好

## 不存的内容

| 内容 | 存储位置 |
|---|---|
| Worker 进程对象 | master 内存 Map |
| Worker 状态 | 进程事件 + `sessions.last_active_at` 推导 |
| 消息历史内容 | pi SDK: `~/.pi/agent/sessions/<cwd>/<sessionId>.jsonl` |
| 错误日志 | master 文件（pino logger）|

**消息历史文件路径存 `sessions.pi_session_path`**（worker 创建 session 后通过 IPC 返回，master 持久化）。master 用这个路径直接读文件（不调 IPC），即使 worker 已 crash / 超时归档，历史仍可查。

## session 配置完全独立

session 创建时**完整复制** agent 配置到 sessions.config。session 整个生命周期**不读 agent 表**。session 内修改 → 更新 sessions.config（不写回 agent 表）。

## IM 渠道表（2026-08-26）

主包 `db/init.ts` **不写**任何 IM 渠道表 DDL。所有 IM 渠道表由各渠道包在 `register()` 时通过 `ChannelHost.executeMigration()` 自管：

| 表 | 归属 | DDL 拥有者 |
|---|---|---|
| `channels_wechat` | `platform/channels/channel-wechat/` | 微信渠道包 |
| `channels_qq` | `platform/channels/channel-qq/` | QQ 渠道包 |

> **MVP 简化**:QQ 群聊 / bindings / per-route 配置推迟，`channels_qq_routes` 表 MVP **不创建**。群聊支持时再加。

**主包零渠道 DDL 约束**:
- `apps/pi-agent-server/src/db/init.ts` 中 MUST NOT 出现 `CREATE TABLE` 针对以上两张表
- 渠道表 schema 演进由对应渠道包负责，加字段不需要改主包
- 渠道包可以独立修改自己的 schema，发布新版本时同步更新 migration

**为什么主包不写 DDL**:
- 主包对渠道实现零知识（P1 设计原则）
- 加 / 删渠道不需要修改主包 db/init.ts
- 各渠道字段独立演进（微信 `storage_dir` / QQ `app_id` + `app_secret` 等无共享字段）

**会话生命周期**:渠道表里的 `current_session_id` 是渠道级状态（哪个 chat 跟到哪个 session），不属于 sessions 表。IM 网关 session idle timeout 走**内存 Map**（不动 sessions 表）。详见 `pi-agent-server_im-gateway.md` 的 D16 段。

## 路径规范化

**所有路径字段**（`agents.workspace_path`、`sessions.pi_session_path`）入库前 MUST 经过 `normalizePath()`：

```typescript
// apps/pi-agent-server/src/utils/normalize-path.ts
export function normalizePath(p: string): string {
  // 1. 统一分隔符为 /
  let normalized = p.replace(/\\/g, "/");
  // 2. Windows 盘符小写（C: → c:）
  if (/^[A-Z]:/.test(normalized)) {
    normalized = normalized[0].toLowerCase() + normalized.slice(1);
  }
  // 3. 去除尾部 /（保留根路径 /）
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}
```

**规范策略**：
- **DB 存储**：`forward slash` 风格 + Windows 盘符小写（如 `c:/users/foo/workspace`）
- **API 输出**：DB 原样输出（已是规范化格式）
- **运行时**：传给 fs API / 进程 spawn 时用 `path.normalize()` 转 native

**大小写策略**：
- **DB 中**路径段大小写**保持原样**（不 lowercase）
- **查询 / 比较**：调用方负责按平台决定是否 lowercase
  - Windows / macOS HFS+（默认 insensitive）：lower 比较
  - Linux（默认 sensitive）：原样比较

**什么时候调用**：
- **写入前**（repo.create / repo.update）：调用 normalizePath
- **读取后**：不再处理（已是规范化）
- **路径比较**：调用方按平台决定

**为什么**：
- 跨 OS 一致（forward slash）
- Windows 盘符约定（`c:` vs `C:`）
- 避免尾部 `/` 的等价路径出现两份记录
- 与 pi-agent-extension / pi-server-main 等项目的约定一致

## 相关文档

- [`pi-agent-server_session-lifecycle.md`](pi-agent-server_session-lifecycle.md) —— 配置管理策略
- [`pi-agent-server_im-gateway.md`](pi-agent-server_im-gateway.md) —— IM 网关 + 渠道包自管表说明
