# channel-qq

QQ channel package (p2p only in MVP). Implements `ChannelPackage` + `ChannelAdminPage`.

## ⚠️ License

`qq-bot-sdk` is **AGPL-3.0**. Using this SDK in your server makes the whole server
source AGPL-3.0 (network use clause). If your server is proprietary, you MUST either:
1. Open-source your entire server under AGPL-3.0, OR
2. Replace this package with a non-AGPL alternative (e.g. write your own using
   QQ Open Platform REST API directly — no SDK).

MVP uses `qq-bot-sdk` mock; real SDK integration pending spike.

## ⚠️ MVP 范围

**仅支持私聊 (C2C)**。**群消息会被 fast-fail**:首次发"群聊暂未支持,请私聊",已告知群静默丢弃。
群聊 / bindings / per-route 配置推迟到下个 change(详见 design.md Open Questions OQ1)。

## Schema

- `displayName` (text, required) — admin 列表显示名
- `appId` (text, required) — QQ Open Platform app id
- `appSecret` (password, required) — QQ Open Platform app secret (token endpoint)
- `defaultAgentId` (text, required) — 私聊默认 agent

## 路由

7 条 (MVP 不暴露 bindings):
- `GET    /api/im/qq/channels`
- `POST   /api/im/qq/channels`
- `GET    /api/im/qq/channels/:id`
- `PATCH  /api/im/qq/channels/:id`
- `DELETE /api/im/qq/channels/:id`
- `POST   /api/im/qq/channels/:id/start`
- `POST   /api/im/qq/channels/:id/stop`

## 行为

- 启动时通过 `appId` + `appSecret` 走 QQ Open Platform OAuth 拿 access_token
- 自动维护 token 刷新(过期前 5 分钟 refresh)
- WebSocket gateway 连接 QQ 服务,接收 C2C 消息
- 群消息(MVP)→ 触发 fast-fail handler,每个 groupOpenid 首次发错误,后续静默

## Markdown

- 尝试 `msg_type=2` (markdown)
- 被 QQ 拒绝时自动降级为 `msg_type=0` (纯文本)