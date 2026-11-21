---
name: webhook
description: 用 webhook 把外部系统的事件接进平台。什么时候该建、URL 和 secret 怎么交给对方、对方该带什么头、失败时怎么查台账。
---

# Webhook 用法

webhook 是**外部事件入口**：外部系统 `POST` 一个请求，平台在指定 agent 的一个会话里执行你写好的指令。

## 什么时候用

| 场景 | 用不用 |
|---|---|
| "CI 挂了告诉我为什么"、"issue 被别人打开就扫一遍"、"监控告警进来处理" | ✅ 用 webhook |
| "每天早上 9 点看盘" | ❌ 用 `schedule_task`（时间驱动不是事件驱动） |
| "webhook 收到后先判断是不是我要的那种，不是就忽略" | ❌ 平台是**哑端点**：过滤逻辑放在外部系统，或者写进 prompt 让未来的自己判断 |

## 建一个

调 `manage_webhook`：

```
manage_webhook {
  action: "create",
  name: "CI 失败",
  prompt: "读 <data> 里的 payload，找出失败的 job，用 read/bash 看日志，最后用 postNotification 把原因发给用户",
  busyPolicy: "followUp"
}
```

返回里有两个必须拿出来的东西：

- **URL**：`<你的服务地址>/api/p/webhook/hooks/<id>`
- **Secret**：32 字符

把这两个交给要调用的一方。之后对方这样调：

```
curl -X POST '<URL>' \
  -H 'Authorization: Bearer <secret>' \
  -H 'Content-Type: application/json' \
  -d '{"event":"deploy.failed","service":"api"}'
```

## 对方需要知道的四件事

1. **鉴权是 `Authorization: Bearer <secret>`** —— 没有别的形式，secret 与这条 URL 绑定
2. **body 原样进 `<data>.payload`**（请求头信息在 `_meta`），超过 64 KiB 会被截断
3. **需要去重就带 `Idempotency-Key` 头**：同一 key 24 小时内只执行一次，重复调用返回 `duplicate`（平台**不会**用 body 内容自动去重）
4. **响应码**：`202` 已送达 / `200` 重复 / `409` 没执行（停用、跳过、失败）/ `401` secret 不对 / `404` 这个 id 不存在

"已送达"只表示**消息进了 agent**，不表示活干完了。

## 三种会话模式与忙时策略

| 字段 | 取值 | 含义 |
|---|---|---|
| `sessionMode` | `new`（默认） | 每个事件一个新会话 |
| | `reuse` | 固定复用一个会话（不传 `sessionId` 时首次投递自动创建并绑定） |
| `busyPolicy` | `followUp`（默认） | 收到事件时你正在跑 → 排队，当前轮结束后处理 |
| | `steer` | 插队到当前轮之后的下一次模型调用（会打断手头的事，只用于告警） |
| | `skip` | 这次不投，记一条 `skipped`（高频事件用这个，避免队列堆积） |

## prompt 怎么写

事件到达时，平台会把 `prompt` 原样放进一条**平台消息**送进会话，body 在 `<data>` 里。所以 `prompt` 是**写给未来的自己的一句指令**，要写清楚：看什么、输出到哪、什么算成功。

- ✅ "读 `<data>.payload` 的 `workflow_run` 字段，找出失败的 job 并说明原因，最后用 postNotification 发给用户"
- ❌ "处理一下这个事件"（没说处理成什么）
- ❌ 不要自己编写平台消息格式（`<system-event>` 之类），那是平台发的

## 失败怎么查

投递失败会记在台账里（`/webhooks/<id>` 页面的「最近投递」），并推一条通知给收件箱。常见原因：

| 现象 | 原因 |
|---|---|
| `会话不存在` / `会话 … 不属于该 agent` | `reuse` 的绑定目标被删了或换了 agent |
| `401` | secret 不对（或对方用了别的头） |
| `404` | hook id 不存在（被删了、或 URL 拼错） |
| 反复 `busy` | 事件比单轮更快，改 `busyPolicy: "skip"` 或降低对方频率 |

## 不要做的事

- 不要自己拼 URL 里的 token（平台只认 Bearer 头，不认 query 参数）
- 不要把 secret 发给不相关的地方 —— 它是"谁能往这个 agent 里塞消息"的唯一凭证
- 不要指望平台重试：失败就是失败，让对方按 `Idempotency-Key` 重投

> **给其他插件用**：本插件把管理能力暴露成 service（`webhook.hook.list / webhook.hook.create / webhook.hook.update / webhook.hook.delete`），
> 通过 `host.services.call(name, payload)` 调用；**请不要直接读本插件的表** —— 表结构不是契约。
