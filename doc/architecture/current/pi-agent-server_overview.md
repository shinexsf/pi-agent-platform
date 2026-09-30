# pi-agent-server overview

> pi-agent-server 子项目的架构入口。

## 系统全景图

```mermaid
flowchart TB
    subgraph Client["渠道层"]
        WebUI["Web UI<br/>(Vue3)"]
        IDE["IDE插件<br/>(JCEF)"]
        IM["IM渠道<br/>(QQ + 微信)<br/>✅ 已实施"]
        TUI["pi TUI<br/>⏸️ 待定"]
    end

    subgraph Master["Server (master 进程)"]
        HTTPAPI["HTTP API<br/>(hono)"]
        SSE["SSE<br/>(Web / IDE 流式订阅)"]
        IMGateway["im-gateway/<br/>(QQ WebSocket / 微信 long-poll)<br/>✅ 已实施"]
        SES["services/session.ts<br/>SessionRegistry 单入口 + Session 领域对象"]
        WPM["WorkerPool<br/>(child_process.spawn)"]
        DB[("SQLite<br/>agents + sessions + attachments + 渠道表")]
    end

    subgraph Worker["Worker 进程 (每 session 一个)"]
        Proxy["AgentSessionProxy<br/>(implements AgentSession)"]
        SDK["pi SDK<br/>(createAgentSession)"]
    end

    WebUI -->|HTTP + SSE| HTTPAPI
    IDE -->|HTTP + SSE| HTTPAPI
    IM -->|WS / long-poll| IMGateway
    HTTPAPI -->|spawn / 管理| SES
    IMGateway -->|ensureSession| SES
    SSE -->|subscribe| SES
    SES -->|spawn / IPC| WPM
    HTTPAPI -->|prompt / abort IPC| WPM
    IMGateway -->|prompt / kill| WPM
    WPM -->|session_event / crash| SES
    WPM -->|IPC| Proxy
    Proxy -->|method dispatch| SDK
    WPM <--> DB
    SDK -.->|历史文件| PiHist[(~/.pi/agent/<br/>sessions/<id>/)]
```

## 核心思想

Server 是一个 Node.js 进程（master），负责 HTTP API、DB 持久化、worker pool 管理。每个 session 对应一个 worker 子进程，worker 内通过 pi SDK（`createAgentSession()`）运行 agent。Master 通过 `AgentSessionProxy`（implements pi SDK 的 `AgentSession` 接口）跟 worker 通信，代码层面看起来像直接调 SDK，不引入自定义协议概念。

**关键约束**：
- 协议所有权在自己（master ↔ worker），不在 pi
- 100% 能力暴露（worker 包装 SDK，可以扩展）
- pi 升级不影响 master（隔离在 worker 内）

**Session 服务层**（2026-09-30 立层）：session 的 spawn / 复活只有**一个入口** —— `services/session.ts` 的 `SessionRegistry`（`getOrCreate` / `createFromAgent`）；领域状态（hasRow / model / systemPrompt 等）与事件订阅归 `Session` 对象，worker-pool 只剩进程事实。依赖铁律见 [invariants](pi-agent-server_invariants.md)。

## 渠道接入

| 渠道 | 接入 | 说明 |
|---|---|---|
| Web | HTTP + SSE | ✅ MVP |
| IDE (JCEF) | HTTP + SSE | ✅ MVP |
| **IM (QQ + 微信)** | **渠道包:QQ WebSocket + 微信 iLink HTTP long-poll** | ✅ **已实施（23 条 API + 真实收发 / 重启恢复 / 附件已实测，详见 `pi-agent-server_im-gateway.md`）** |
| pi TUI | 待定 | ⏸️ 暂未集成 |

## 子模块架构索引

| 子模块 | 文档 | 状态 |
|---|---|---|
| worker-pool | [`pi-agent-server_worker-pool.md`](pi-agent-server_worker-pool.md) | ✅ 已写 |
| ipc | [`pi-agent-server_ipc.md`](pi-agent-server_ipc.md) | ✅ 已写 |
| session-lifecycle | [`pi-agent-server_session-lifecycle.md`](pi-agent-server_session-lifecycle.md) | ✅ 已写 |
| db-schema | [`pi-agent-server_db-schema.md`](pi-agent-server_db-schema.md) | ✅ 已写 |
| http-api | [`pi-agent-server_http-api.md`](pi-agent-server_http-api.md) | ✅ 已写 |
| **im-gateway** | **[`pi-agent-server_im-gateway.md`](pi-agent-server_im-gateway.md)** | ✅ **已实施** |
| **capabilities** | **[`pi-agent-server_capabilities.md`](pi-agent-server_capabilities.md)** | ✅ **已上线**（callServer meta-tool + 控制面 registry→dispatch→授权→审计，8 能力） |
| **invariants** | **[`pi-agent-server_invariants.md`](pi-agent-server_invariants.md)** | ✅ **已写**（架构层 hard rules，含 Session 服务层 6 条） |
| **packaging** | **[`pi-agent-server_packaging.md`](pi-agent-server_packaging.md)** | ✅ **已定**（pi-server npm tarball + `PI_SERVER_CLI` 双模式启动） |
| **debug-testing** | **[`pi-agent-server_debug-testing.md`](pi-agent-server_debug-testing.md)** | ✅ **已写规范**（unit tests 替代品 — dev-only debug 端点 + curl 验证；debug 代码解耦三约束） |
| **logging** | **[`pi-agent-server_logging.md`](pi-agent-server_logging.md)** | ✅ **已定**（pino JSON 单时间线 + worker stderr tee + RollingFileSink 固定名滚动 + console 桥） |

## 待决项

| 项 | 状态 |
|---|---|
| worker 数量策略（固定 / 动态 / 无限制）| ⏸️ 暂不定 |
| worker 崩溃重启策略 | ✅ 已定 —— 崩溃不自动重启，用户消息懒恢复（见 `pi-agent-server_invariants.md` / `pi-agent-server_session-lifecycle.md`） |
| worker 日志聚合 | ✅ 已定 —— 见 `pi-agent-server_logging.md`（stderr tee 进主时间线） |
| session 超时配置粒度 | ⏸️ 未讨论 |
| pi TUI 接入方式 | ⏸️ 待定 |
| IM 渠道(微信 iOS 限制 / qq-bot-sdk AGPL)| ⏸️ 见 `pi-agent-server_im-gateway.md` 待决项 |

## 相关决策

架构层 hard rules 集中在 [`pi-agent-server_invariants.md`](pi-agent-server_invariants.md)（不能动，动前须写架构变更重新评审）；模块内关键决策表见各子模块文档（如 [`pi-agent-server_im-gateway.md`](pi-agent-server_im-gateway.md) 的 D1–D25）。