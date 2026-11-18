---
name: pi-capabilities-usage
description: 当需要查询或修改平台状态（server 版本与 worker 池、agents、sessions、渠道配置、能力面本身）时读这份。讲 callServer 的发现流程（list / detail）、两层授权与被拒的原因、立即生效还是下次 spawn、写操作的最小权限做法。
---

# server 能力面（callServer）用法

`callServer` 是一个**元工具**：它把你对平台的查询与修改转发到 server 的控制面。你不需要记参数，需要的是**发现流程**和**边界**。

## 1. 两个内置方法先把地图打开

| 方法 | 作用 |
|---|---|
| `callServer { method: "list" }` | 按模块分组列出**你被授权的**业务方法（server / agent / session / channel / config） |
| `callServer { method: "detail", params: { method } }` | 单个方法的完整参数表、返回结构、**生效时机** |

规矩：**任何方法第一次用之前先 `detail`**。参数以服务端 schema 为准，凭印象编字段名是最常见的失败原因。调用不存在的方法时，错误信息会回带可用方法列表——照着改。

## 2. 两层授权，被拒时看原因本身

1. **会话白名单**：只有 agent / session 配置里显式列出的方法才可调用。没配 → 一个都不能调；配了空数组 → 同理。
2. **own-scope（写操作）**：写方法只能指向**你自己的** agent / session / 触发器行。读方法可以跨 agent 看（个人平台）。

典型拒绝信息与含义：

| 错误 | 含义 | 怎么办 |
|---|---|---|
| `method not in agent capabilities allowlist` | 这个会话没被授权该方法 | 告诉用户去 agent/session 配置里勾上，不要循环重试 |
| `own mode: caller may only target its own … rows` | 你在改别人的东西 | 只能改自己名下的资源；跨 agent 的运维操作请让用户来做 |
| `no explicit capabilities configured …` | 完全没配置能力 | 同上：先要授权 |

被拒**不是 bug**，是边界。把原因如实转告用户，比换个写法再试一遍有用。

## 3. 生效时机（写操作前必看）

| 类别 | 例子 | 什么时候生效 |
|---|---|---|
| 即时（DB 或 IPC） | `session.update` 的 `model` / `thinkingLevel` / `title` | 立刻；worker 活着时连 IPC 一起改 |
| **下次 spawn** | `agent.update` 的 `config`；`session.update` 的 `config.*` | 只影响**新建**的会话（会话是创建时的配置快照）；想让改动立刻在某个会话生效 → 配合 `session.restart` |
| 破坏性 | `session.restart`（kill + 重建，复用历史）、`*delete` | 立刻；`restart` 会中断正在跑的那轮，而且 busy 时会被拒 |

一个实际推论：**改 agent 配置 ≠ 改现有会话**。用户说"改了怎么没效"，先看那条会话是不是老会话。

## 4. 写操作的做法

- **先读后写**：`agent.list` / `session.list` 拿到 id 再动；不要凭上下文里的猜测拼 id。
- **`agent.update` 的 `config` 是整体替换，不是合并**：读到完整 `config`，改你需要的那几项，再整体写回。只传一部分 = 把其余项清空。
- **一次只改一件事**：确定要改什么、改完怎么验证（再 `get` 一次）。
- **不要用写操作做探测**：想知道当前值就读，不要"改一下看看返回"。
- 写操作会进平台审计/日志；小步、可解释的改动比一次大改好排查。

## 5. 各模块大概能做什么（细节用 detail 现取）

| 模块 | 能做什么 | 注意事项 |
|---|---|---|
| `server` | `status`：版本、uptime、端口、worker 池统计 | 只读，且**不含任何凭据**；排查"卡住了/没 worker"先看它 |
| `agent` | 搜索/取详情/局部更新配置 | 更新只影响未来会话；`workspacePath` 必须是已存在路径 |
| `session` | 搜索/取详情/改名/换模型/改配置/重启 | `config.*` 下次 spawn；`restart` 会打断当前轮次 |
| `channel` / `config` | 占位（目前无业务方法） | 出现在 `list` 里不等于可用 |

## 6. 你手里没有的东西

- 没有数据库直连、没有 shell、没有日志文件读取——这些是 **agent 工具**或 debug 端点的事，不是 `callServer` 的事。
- debug 端点（`/debug/*`）只在开发态存在，不要假设生产可用。
- 看不到凭据（模型 key、webhook secret 等）；平台刻意不暴露。

## 7. 常见反模式

- ❌ 不 `detail` 就按印象传参数（字段名/结构记错是最高频失败）
- ❌ 被 own-scope 拒了以后换参数重试十次（拒绝是按**归属**判的，换参数没用）
- ❌ `agent.update` 只传半个 `config`（其余字段被清空）
- ❌ 改完不看结果就报告"已生效"（改完 `get` 一次，或说明"下次新会话生效"）
- ❌ 用 `session.restart` 当刷新按钮（会打断正在进行的一轮）
- ❌ 把 `list` 的结果当成"我能做的一切"（它只列**已授权**的；没列出来的就是没授权）
