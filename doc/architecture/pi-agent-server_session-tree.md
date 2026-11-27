# pi-agent-server session-tree

> **会话文件本来就是树**：pi 的 JSONL 一行一条 entry，靠 `id` / `parentId` 串联；切分支不删行、
> 不新建文件，只移动"当前 leaf 指针"。本文讲平台怎么把这棵树暴露出来，以及**为什么 leaf 不落库**。
>
> 配套：`session-lifecycle.md`（会话对象与状态机）、`db-schema.md`（`parent_session_id` 两列）。

## 一句话轮廓

```
POST /api/sessions/:id/tree/navigate   → 在同一文件内移动 leaf（pi 的 /tree）  ← 只剩这一个写动作（rewind）
POST /api/sessions/:id/fork            → 抽出一条路径成**新会话**（新文件 + 新行）
SSE  session_branch                    → 分支变了（包括 worker 消失）
插件面 host.sessions.{tree,navigate,fork}（与 HTTP 同一份实现）
```

**读树的 HTTP 端点（`GET /api/sessions/:id/tree`）已经移除**：树的可视化搬进本机插件
`session-tree`（见「客户端」一节），平台不再对外暴露树的读接口，内部面照旧保留。

## 边界：内核留什么、插件拿什么（2026-11-27）

| 层 | 保留 | 不再提供 |
|---|---|---|
| 内核（`packages/core`） | `session-file.ts` / `session-tree.ts` / `session-fork.ts` 全套读写 | — |
| worker | `getSessionTree` / `getLeafId` / `navigateSessionTree` | — |
| 插件面 | `host.sessions.tree()` / `.navigate()` / `.fork()` | — |
| HTTP | `POST /:id/tree/navigate`、`POST /:id/fork` | ~~`GET /:id/tree`~~ |
| web | 消息 hover「回到这里」（= navigate）、顶栏 `⋯` 里的「分叉」 | ~~`SessionTreePanel.vue`~~、~~rail「分支」抽屉~~ |

判据：树是**一个会话文件里的事实**，读它不需要平台出接口 —— 关心它的是"看图的人"，
所以图连同它的 HTTP 面一起搬进插件；平台只留两个**页面级动作**（回退一句、分叉一次）。

## D1 · leaf 只有一份，在 pi 的内存里

| 情况 | leaf 来源 |
|---|---|
| worker 存活 | `__core__.getLeafId`（= pi `SessionManager.getLeafId()`） |
| worker 不在 | 文件最后一条 entry 的 id（= pi `SessionManager.open()` 的 `_buildIndex()` 规则） |

**平台不缓存、不落库**（`sessions` 表没有 leaf 列）。理由：pi 自己就不持久化它 ——
`/tree` 的 UX 是"把文本放回编辑器，改完重发"，**一次 append 才让新分支成为持久事实**。
平台再存一份指针就是第二套真相，且与 pi 的 resume 行为分叉。

唯一的判断是 `workerPool.has()`：进程在不在。这不是一致性问，是对象存活问。

> `appendXxx` 全部用 `{ parentId: this.leafId }`，所以任何 append（改名、切模型、压缩、
> 插件 `pi.appendEntry`、usage 记账）都落在当前 leaf 之下 —— "用文件末尾当 leaf" 永远
> 落在同一分支上，不会把刚导航的位置丢掉。反过来说，**不能**靠"收到某类 append 事件就
> 让 leaf 失效"来维护副本：来源太多，清单必漏。

## D2 · 读树/切分支在 worker，fork 在 master

| 操作 | 放在哪 | 为什么 |
|---|---|---|
| 读树 / 切分支 | worker（`__core__.getSessionTree` / `navigateSessionTree`） | 只有 `AgentSession.navigateTree()` 会同时刷新 `agent.state.messages`（模型上下文）与工具集；直接调 `sessionManager.branch()` 会留下"上下文与分支脱节"的会话 |
| fork | server 侧 `services/session-fork.ts` | `SessionManager` 是纯文件类（`open()` 静态方法），master 已依赖 pi（`model-registry.ts`），为了复制一个文件去 spawn agent 进程不值得 —— 会话在列表里多半是冷的 |

冷会话读树/导航会**先懒恢复** worker（与 `/prompt` 同一条路径）；起不来返回 409
`worker_not_running`。

懒恢复必须走 `sessionRegistry().getOrCreate()`，**不能只看 `workerPool.has()`**：worker 进程起来
到 `createSession` 跑完之间有个窗口，这期间调内核方法会报 `no active session`（另一个请求正在
spawn 时踩到，冷会话首次打开分支面板就 500）。`getOrCreate` 能蹭到同一个 inflight promise，
已经在跑就等它跑完；会话本来就热时它的快速路径是同步返回。

## D3 · 导航的副作用与广播

`navigateSessionTree(entryId)` 成功后必须做两件事：

1. **广播 `session_branch`**（`{ leafId, oldLeafId, reason: 'navigate' }`）。
   pi 的 `session_tree` / `session_before_tree` **只经扩展运行器发出，订阅者收不到** ——
   宿主不自己发，别的窗口就停在旧分支上（看起来像 bug）。
2. 客户端据此**重新拉一次 `/messages`**（事件本身不带消息列表，避免两条真相）。

`reason: 'worker-gone'` 在 worker 被 kill / 崩溃时发出（`leafId` = 文件末尾），且必须**同步**
投递：紧接着 `notifyDisposed()` 会清空订阅者，排队事件会被丢掉。

## D4 · 历史端点按 leaf 回溯

`GET /api/sessions/:id/messages` 只返回**当前分支**（root → leaf）上的消息；被放弃的分支
MUST NOT 出现。实现：一次线性扫描建 `id → { parentId, line }` 索引（只取这两个字段），
从 leaf 回溯出分支 id 集合，窗口/分页只在该集合内取。

- **游标仍是文件行号**（`before=<行号>`，`nextBefore` 给下一次用的行号）→ 老客户端无感
- `hasMore` MUST 按当前分支判断（`startIdx > 0` 会被"前面全是别的分支"骗到）
- **不做 compaction 裁剪**：那是模型上下文的事（pi 的 `buildContextEntries`）；UI 要的是
  "这条分支上真实发生过的消息"，压缩前的消息本来就该显示

## D5 · fork：fail-closed 六步 + 新会话是"冷会话"

```
1. session 不存在                         → 404
2. position='before' 且 entry 不是 user   → 400 invalid_entry_for_position
3. entryId 找不到                         → 404
4. 分叉点之前没有对话内容                 → 409 fork_has_no_conversation
5. 源 pi 文件不存在（还没落盘）           → 409 source_not_persisted
6. createBranchedSession() 产物不存在     → 500（防御性；理论上前一步已挡住）
```

**契约**：成功返回的 `piSessionPath` MUST 指向真实存在的文件。悬空路径交给 worker 会被
`existsSync ? open : undefined` **静默变成"新建空会话"**。

第 4 步为什么必要：pi 的落盘是 lazy 的（`_hasConversation()` = 路径上有 user/assistant 消息
才写文件）。"在第一轮对话之前分叉"因此既没有内容也不会有文件，语义上等于新建会话 ——
平台直接 409，不发明"空会话 + parentSession"这种分支。

新会话行：

| 字段 | 取值 |
|---|---|
| `agent_id` | 与原会话相同 |
| `model` / `thinking_level` / `config` | **原会话行快照**（可被入参覆盖），不是 agent 当前值 |
| `parent_session_id` / `forked_from_entry_id` | 血缘（后者是**实际 target**，clone 也有值） |
| `title` | 入参，否则 `<原 title> · 分叉` |
| worker | **不启动**（懒到首条消息；与"归档恢复"/"worker 回收后继续"是同一状态） |

## D6 · 附件跨会话：复制行 + hardlink

附件按 `(session_id, sha)` 隔离、磁盘在 `<attachmentsDir>/<sessionId>/`，而 JSONL 里的
`<file att_xxx>` 标签是内容哈希（跨会话不变）。fork 时：

- **行**：以新 `session_id` 复制 → 标签原样命中
- **文件**：`fs.link` 建 hardlink（零字节复制）→ 删任一方只 unlink 自己的目录项
- `EXDEV` / `EPERM` / `ENOTSUP`（跨卷、FAT32/exFAT）退化为 `copyFile`（warn 记录）

## 并发与多窗口

一个会话只有一个 leaf 指针，多窗口共享：

| 场景 | 行为 |
|---|---|
| 流式中导航 | pi 抛错 → 409 `session_busy` |
| 两个窗口各跳一个节点后发消息 | 后一次导航生效；另一个窗口收到 `session_branch` 后重载 |
| 导航后 append（任何来源） | append 挂在当前 leaf 之下 → 文件末尾就在该分支上，导航被"固化" |

`navigate` 支持 `expectedLeafId`：与当前 leaf 不一致时 409 `leaf_mismatch`（带当前 leaf），
避免"最后导航赢"让另一个窗口静默错位。

## 客户端：平台两个动作 + 插件一张图

**平台（`apps/pi-agent-web`）只剩两个动作，没有树面板**：

- **回到这里**（user 消息 hover）：`POST /:id/tree/navigate` → leaf 挪到该消息的 parent +
  文本回填输入框（pi 原生语义，`editorText` 由 pi 返回）。流式中禁用（pi 会抛 `session_busy`）
- **分叉**（顶栏 `⋯` 菜单，与「关闭会话」并列）：`POST /:id/fork` 不带 `entryId` = clone
  当前 leaf；成功后整页跳到新会话（本组件不支持同一实例换会话）
  - 菜单是**扩展点**：平台项与"插件将来追加的项"共用同一个数组（`headerMenuItems` 的形状），
    以后开给插件时模板不用动
- 不做任意节点跳转 —— 树上的"从任意点继续"是插件的自由，平台只承诺 rewind 这一种语义

**插件（`plugins/session-tree`，本机桶，待转正）**：`chat.rail.right` 槽位 + 自己的 HTTP 面
（`GET /tree`、`POST /rewind`、`POST /fork`），全部转调宿主能力面，不复制逻辑。
面板是**原生 ESM + DOM**（插件 web facet 没有框架），算法与平台原先那版一致：

- 右侧 rail「分支」抽屉 = **git graph + 懒展开**（`plugins/session-tree/web/panel.js`）
- **两个轴是分开的**：**轨道（第几列）按当前 leaf**，**颜色/编号按首父语义（谁先建）**
  - 轨道：root → leaf 永远是 lane 0（"你所在的这一列"第一眼就看到），其余按 DFS 分列
  - 身份：每条线最先生的孩子**沿用父线的编号**，后来生的各自成新线；新线编号 = 它
    **第一次出现的时间顺序**（不是 DFS 顺序），#1 = 最早那条。颜色 = `(编号-1) % 4`
    （accent / success / warning / danger）
  - **为什么要分开**：只按 leaf 定身份的话，每次切 leaf 整张图重排 —— 分支从绿变蓝、蓝变绿，
    颜色作为"身份"就失效了。按首父定身份后，颜色/编号是节点的稳定属性，切 leaf 只是
    「当前」标记挪位置
  - 代价：当前路径上"换了线"的地方（走到某个分叉的非第一个孩子）lane 0 的颜色会变 ——
    这正好在视觉上标出"你从这儿换到另一条线了"，线起点用 `#N` 标签注明
  - 当前线的高亮**只能靠粗细**（`3px` vs `2px`），不能靠颜色 —— 颜色已经用来表达身份
- **主干（root → leaf）永远完整显示**；主干上每个岔出去的孩子各占**一行**，可单独展开
  - 折叠态：一行 = 一条支线，右边 `+N` 表示后面还藏着几项 —— 所以"这里分了几个叉"一眼可数
  - **只有支线 head 行有展开箭头**（`isHead`）。按"这一行有孩子"给箭头是错的：展开后的每一行
    都有孩子，会满屏 `▸` 且点了没反应
  - 展开态：按同一条规则递归（线性往下走，遇到它自己的分叉再铺开），车道 +1，颜色换一个
  - 19 条的会话 6–12 行；146 条的长会话十几行
  - **leaf 之后继续走到第一个分叉点**再停：刚点「从这里继续 / 改这句重发」时，被放弃的那条线
    会以尾巴的形式露出来（灰显），再远就要展开
- **行序 = entry 时间序（= JSONL 行序）**，不是 DFS 顺序
  - DFS 只负责**结构**（谁是谁的孩子、谁占哪条车道、哪里画分叉），行一律按 `timestamp` 排
  - 之前直接输出 DFS 顺序的后果：主线走到 leaf 的所有行被排在前面，支线的行压到后面 ——
    "最新发出的两条"（时间上最后）反而出现在中间，看着像"没排到底部"
  - 时间序的可靠性：pi 逐条 append，实测 58 条 entry 的 `timestamp` 与文件行序 **0 处不一致**
  - 没有 timestamp 的（理论不存在）排最后，并保持 DFS 相对顺序
- 车道线的可见区间改由**车道段**（`startId` → `endId`）反推：排序后按行下标记区间，
  每行 `open` = 覆盖它的所有段。这样无论行怎么排，线都能跨过中间那些"别的分支"的行
  - 段的端点行找不到时**丢掉整段**。早先写成 `indexOf.get(id) ?? 0`，找不到的段会被拉到
    列表第 0 行 → 列表最上面冒出一小截莫名其妙的分支竖线（用户看到的"竖线向上超出"）
  - **不属于本行的线画虚线**（`dashed = 段车道 !== 本行车道`）：自己那条线实线、路过的线虚线，
    一眼分得清"这行属于哪条线、哪条线只是路过"
  - 经由斜线岔出来的车道，其竖线**起点 = 斜线末端**（父行底边），不是父行圆点：
    否则竖线会比斜线高出一截，看起来像"凭空从上面长出来"（用户报的"虚线第一行头上超出"）
  - **同一车道上的两段不能区间重叠**：车道是 DFS 时复用的（走完一条支线就把车道还给后面的
    支线），但行是按时间排的 —— 用户在分支之间来回切换时两条支线的时间区间会交错，复用出来的
    两段就重叠，后画的盖掉前一段（症状：绿色支线展开后绿线跨过黄色支线区域）。
    排序后做一次**冲突重排**：按 start 排序逐段检查，重叠就把该段连同它自己的行挪到空闲车道
    （`forkLines` 引用的是"段"而不是车道号，挪完斜线自动跟上）
- 图形细节（都是踩过坑才定下来的）
  - **分叉标记画在"岔出去的那个节点"那一行上**（父行），不是画在支线的第一行 —— 支线在文件里
    可能晚几百行才出现，画在支线行会让人以为它挂错了父节点
  - 实现：父行上为每个非主线孩子**预留一条车道**（`reserveBranches`：当场 `enter` + 在本行记一条
    `forkLines {from,to,color}`），这条车道的竖线就从父行圆点一路画下去，穿过中间那些主线行，
    直到支线的实际行 —— 正是 git graph 的 `|\`。兄弟支线各占一条车道（不会挤同一列）
  - 连接线是**斜线**（SVG `line` + `preserveAspectRatio="none"`），从父行车道落点画到目标车道，
    不是横杠
  - **颜色只表达分支，不表达消息类型**：主线 = `--accent`，支线按 1/2/3 轮转取 `--success` /
    `--warning` / `--danger`（同一个分叉下的兄弟支线一定不同色；不放灰色，灰色像"没有分支"）。
    圆点和它所在车道同色
  - 消息类型改用**行首文字标签**（`用户` / `助手` / `工具` / `系统` / `模型` / `思考` / `压缩`…）——
    颜色这一条通道给了分支，类型就不能再靠颜色编码
  - 支线行还有**一档更浅的同色底**（`--accent-soft` / `--success-soft` / `--warning-soft` /
    `--danger-soft`，主线不着色），扫一眼就知道这一行属于哪条支线；底色规则必须排在
    `:hover` / `.selected` **之前**，否则选中态被底色盖掉
  - 线段**必须是实色**：早先给线加 `opacity: .75`，而相邻行靠上下各外扩 7px 盖住行间距，
    重叠区 0.75 叠成 0.94 —— 看起来"一段深一段浅"。行内 flex 的 `align-self: stretch`
    撑不满行高（实测停在 `min-height`），所以外扩这条保留，配实色即可两全
  - **竖线的起止按"车道段"算，不是按车道号**：车道会被不同支线先后复用，只记"该车道首末行"
    的话，后一条支线会白拿前一条的起止，于是起点上方、终点下方各露出一截线。段身份 = 车道号 + 颜色
  - **叶子（可见树里没有孩子）= 空心圈 + 外环**，车道竖线**画到圆点就停**；当前 leaf 再叠加双环 +
    「当前」
  - leaf 之后那段 lane 0 画成**虚线**（`mask-image` 周期）。它只是后面支线的挂点，实线会让人
    以为"这条线还能往下走"
  - 车道数封顶 4（面板只有 ~350px，再深就压平在最后一条车道上）
  - 竖线 `top/bottom` ±7px 外扩跨过行距：`<button>` 内部的 `align-self: stretch` 不可靠，
    靠 `min-height` 撑出来的高度短于行高（症状：线看起来是一段段的虚线）
- **筛选只影响展示**，不影响导航能力：用户 / 助手 / 工具 / 系统 + 「只看主线」，记忆在
  `localStorage['pi.sessionTree.view']`
  - **被隐藏的节点把子节点上提**，不是整棵子树消失 —— pi 的 entry 逐条嵌套，直接砍子树会把
    消息一起藏掉；隐藏后「孩子数」也会跟着变，折叠结构自动按新的可见树算
  - leaf 被筛掉时表头给「已隐藏」提示，否则用户以为"当前"丢了
- 加载后自动把 `当前` 滚进视野（长会话的 leaf 常在几百行之外）
- flex 行里的文本必须 `min-width: 0`，否则 ellipsis 永远不生效（整行被文本顶宽 → 右边截断）；
  `.tp-tree` 同时 `overflow-x: hidden` 兜底
- 点 user 消息 → 「回到这句」（= 平台的 rewind，同一个端点）；点其它节点只显示说明
- 「从这儿分叉」只在"之前已有对话"的 user 消息上可用（与后端同一判据）
- 插件拿不到输入框：回填走约定事件 `pi:editor-draft`（宿主 `ChatView` 监听后塞进草稿）；
  会话内容/分支变化时宿主广播 `pi:chat-changed`，面板据此重读树
- 会话列表 / 详情显示「分叉自 …」（`parent_session_id` + `forked_from_entry_id`）

> **SharedWorker 事件白名单**：web 的 SSE 走共享连接，`workers/sseShared.worker.ts` 的
> `SESSION_EVENTS` 是**白名单** —— 新增具名事件必须同步加进去，否则只在共享连接模式下
> 被静默丢弃（直连 EventSource 没有这个限制，两边行为会不一致）。
