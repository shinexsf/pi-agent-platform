# pi-agent-platform

> ⚠️ **Early Development** — 此项目仍在早期开发阶段，API、架构、数据格式均不稳定，
> 不建议用于生产环境。可能会有 breaking changes without notice。

**Server orchestrator**：基于 [pi SDK](https://github.com/badlogic/pi-mono) 的多渠道 AI agent 接入层。
Server 通过 per-session worker pool 隔离会话，多渠道接入（IDE / Web / QQ / 微信）。

## 子项目

| 子项目 | 说明 |
|---|---|
| [`platform/apps/pi-agent-server`](./platform/apps/pi-agent-server) | Hono 后端：HTTP API + IM gateway + worker pool |
| [`platform/apps/pi-agent-web`](./platform/apps/pi-agent-web) | Vue 3 浏览器端 |
| [`platform/apps/pi-agent-ide`](./platform/apps/pi-agent-ide) | Vue 3 IDE 端（JCEF 加载）|
| [`platform/workers/session-worker`](./platform/workers/session-worker) | 每 session 一个 worker 进程，封装 pi SDK |
| [`platform/packages`](./platform/packages) | 共享 types / IPC 协议 / channel 接口 |
| [`platform/channels`](./platform/channels) | IM 渠道包（QQ / WeChat）|
| [`pi-agent-idea`](./pi-agent-idea) | IntelliJ IDEA 插件（Kotlin + Gradle）|

## 快速开始

需要 Node.js ≥ 22、pnpm ≥ 11。

```bash
pnpm install
pnpm --filter @pi-agent-platform/session-worker build
pnpm --filter @pi-agent-platform/server dev
```

Server 默认监听 `http://localhost:8787`，Web UI 在 `/web/`。

架构文档：[`doc/architecture/`](./doc/architecture/README.md)

## License

[MIT](./LICENSE)
