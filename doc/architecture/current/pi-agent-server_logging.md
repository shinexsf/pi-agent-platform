# pi-agent-server logging

> **统一结构化日志子系统**。全进程 pino JSON 单时间线：master / worker / channels / 第三方 SDK 输出全部汇入同一份滚动日志文件。

## 核心思想

**一个时间线，一个文件，字段化**。所有运行日志是 JSON 行（`{time, level, name, msg, ...fields}`），无论出自哪个进程/模块，最终汇入同一文件——出问题时按 `sessionId` 一查就是全链路，不跨文件拼时间。

## 架构

```
                    ┌────────────────────────────────────────────┐
                    │ apps/pi-agent-server/src/logger.ts (真源)   │
                    │  pino + multistream[stdout, RollingFileSink]│
                    └────────────────────────────────────────────┘
                       ▲ child        ▲ globalThis 注入   ▲ 行解析重打
          ┌────────────┴───┐   ┌──────┴────────┐   ┌──────┴─────────────┐
          │ childLogger()  │   │ channels/     │   │ worker-pool tee    │
          │ session-info   │   │ shared/       │   │ (补 sessionId /    │
          │ prompt-resolver│   │ logger.js     │   │  workerPid 字段)   │
          │ im-gateway …   │   │ im-gateway-   │   │      ▲             │
          └────────────────┘   │ channel       │   │      │ stderr      │
                               └───────────────┘   │ session-worker     │
          console.* 桥接（第三方 SDK 输出 + denylist）│ logger.ts (pino→2)│
                                                   └────────────────────┘
```

- **真源** `src/logger.ts`：`pino({name:'server'}, multistream[stdout, RollingFileSink])`，全同步写（crash-safe）
- **模块 logger**：`childLogger('<module>')`，`name` 字段 = 模块名（im-gateway 在 `im-gateway/logger.ts` 包一层）
- **channels**：`channels/shared/logger.js` 优先取 `globalThis.__piPlatformLogger`（server 进程内注册）的 child；独立 pino 仅作脱离宿主的 fallback。**不允许**再维护人肉镜像副本
- **worker**（独立进程）：`workers/session-worker/src/logger.ts` pino → **stderr**（sync）；master `worker-pool.ts` 逐行解析：JSON 行按原级别重打并补 `sessionId`/`workerPid`，非 JSON 行（栈迹/SDK 输出）落 `raw` 字段 @info；同时保留 `stderrTail`（100 chunks）供 `/debug/sessions/:id`
- **console 桥**：`console.*` 路由进 logger（`src:'console'`），第三方 SDK 输出也进时间线；`心跳校验`/`[CLIENT]` 心跳噪音 denylist 丢弃。启动横幅是唯一 raw-stdout 输出（`process.stdout.write`）

## 级别约定

| 级别 | 用途 |
|---|---|
| `error` | 操作失败、需要关注（含 worker dispatch error） |
| `warn` | 异常但可继续（附件跳过、fallback 命中） |
| `info` | 运行事件（启动、挂载、respawn、listening） |
| `debug` | 诊断探针（`[SESSION-DIAG]`/`[ROUTING-DIAG]`/`[QQ-DIAG]`/`[ATT-DIAG]`），`LOG_LEVEL=debug` 才可见 |

字段化优先：结构化字段（`sessionId`/`agentId`/`err`…）放 fields，**不拼进 msg 模板**。

## 文件与滚动（RollingFileSink）

**固定活跃文件名 + 归档改名重建**（经典 logrotate 语义）：

| 环境 | 活跃文件 | 归档 |
|---|---|---|
| dev | `apps/pi-agent-server/logs/dev-server.log` | `dev-server.<时间戳>.log` |
| 打包态 | `~/.pi/server/logs/server.log`（`PI_LOG_FILE` 注入） | `server.<时间戳>.log` |

- 滚动：写满 `PI_LOG_MAX_SIZE`（默认 10MB）→ 当前文件改名归档 → 重建同名新文件
- 保留：最新 `PI_LOG_KEEP` 个归档（默认 5）
- daemon 的 raw stdout/stderr 兜底在 `server.console.log`（pre-logger 崩溃如模块加载失败可诊断，不混入结构化日志）
- `pi-server logs -f` 恒盯固定名；滚动后文件重建（size 回退）自动从头续流

## 查询方法

```bash
grep '"sessionId":"<sid>"' <log>       # 某会话全链路（master + worker 两侧）
grep '"level":5[0-9]' <log>            # warn / error —— 排查必查
grep '"name":"session-worker"' <log>   # worker 侧日志
```

## 红线

- ❌ `console.*` 打日志（已被桥接，只留给第三方 SDK 输出与启动横幅）——用 `childLogger()`
- ❌ 为 channels 再建独立 logger 副本——走 `globalThis.__piPlatformLogger`
- ❌ msg 拼模板塞可查询信息——放结构化字段

## 相关

- `doc/architecture/current/pi-agent-server_debug-testing.md` —— stderrTail 双通道的 debug 面
- `.pi/skills/agent-testing/SKILL.md`「看日志」——测试流程中的日志检查规范
