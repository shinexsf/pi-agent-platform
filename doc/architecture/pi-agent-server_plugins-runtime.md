# 插件运行期（v2：代码即行为契约）

> change: `plugin-mechanism-v2`。本文描述**当前**实现；v1 的声明式清单、facet 级开关、精确匹配路由均已删除。

## 一句话

插件是**带 `package.json` 的目录**：目录里的子目录决定"在哪装载"，文件里的 `export default { init }` 决定"装载时做什么"，内核给的 `host` 决定"能做什么"。

三条正交的线：

| 线 | 由什么表达 | 谁读它 |
|---|---|---|
| **装载点**（在哪跑） | 目录存在性：`server/` `worker/` `extension/` `web/` | 装载器 |
| **扩展点**（做什么） | 代码默认导出里调的注册函数 | 内核注册表 |
| **能力面**（能做什么） | 内核注入的 `host` 对象（五个能力面） | 插件 |

facet 级开关（`piServer.facets`）与声明式菜单已删除 —— 它们是"第二套真相"，会与代码漂移。

## 四个装载点

| 装载点 | 位置 | 生效时机 | 装载者 |
|---|---|---|---|
| ① server | 运行插件的**那个进程**（当前是 server），`server/index.js` | 启用 / reload 后**立即** | `packages/core/src/services/plugin-extensions.ts` |
| ② worker | 会话 worker 进程，`worker/index.js` | 下次 spawn 该会话 | `workers/session-worker/src/session.ts` |
| ③ pi 原生扩展 | 会话 worker 内的 pi 扩展系统，`extension/index.js` | 下次创建会话 | 同上 |
| ④ 浏览器 | SPA，`web/*.js`（`mount(el, host)`） | 浏览器下次加载 / 刷新 | `apps/pi-agent-web/src/plugins/host.ts` |

**平台自身能力走同一条路**：`callServer` 是 worker 侧的 **inline 插件**（`workers/session-worker/src/inline-plugins.ts`），编译进平台、不经目录发现、不可卸载，但注册动作与目录插件完全一致。判定分界 = **实现方在不在平台代码里**。

## 十一个注册扩展点

| # | 装载点 | 扩展点 | 注册调用 |
|---|---|---|---|
| R1 | server | 页面（**菜单 + 路由一次注册**） | `host.ui.page({ path, label, icon, component })` |
| R2 | server | HTTP 路由（段级模式） | `host.http.route({ method, path, handler })` |
| R3 | server | 反向方法（worker → master） | `host.methods.handle(name, fn)` |
| R4 | server | 表迁移 | `host.db.migrate(name, ddl)` |
| R5 | worker | 正向方法（master/浏览器 → 本插件） | `host.methods.handle(name, fn)` |
| R6 | pi 扩展 | 工具 | `pi.registerTool(def)` |
| R7 | pi 扩展 | 命令 | `pi.registerCommand(...)` |
| R8 | pi 扩展 | 钩子 / 资源注入 | `pi.on(...)` 等 pi 原生面 |
| R9 | 浏览器 | 挂载点 + 组件 | `host.ui.slot({ slot, id, component })` |
| R10 | 浏览器 | 工具卡接管 | `host.ui.toolCard({ tool, mode, entry })` |
| R11 | 浏览器 | 顶栏动作（图标按钮 + 面板） | `host.ui.headerAction({ id, icon, title, component, badge? })` |

定时器**不在清单里**：它没有注册动作，是 `init()` 里自起的资源（平台不管调度、不补跑）。

### 顶栏动作区（R11）

顶栏右侧是**插件可扩展的图标按钮区**（GitHub 右上角那种），平台的架构图 / 主题切换与插件动作共处一排：

- **形状仍是一条**："地址 + 组件" —— 点开后在顶栏下方就地展开面板（不跳页），面板内容 = `web/<component>.js` 的 `mount(el, host)`
- **折叠**：桌面全平铺；紧凑端只留 `INLINE_ON_COMPACT`（当前 1）个插件动作，其余与平台的架构图一起进「更多」菜单。**主题切换始终常驻**（全站开关，藏进二级菜单没人找得到）
- **角标**：`badge: { endpoint: '/unread-count' }` → 宿主每 60s `GET /api/p/<id><endpoint>` 取 `{ count }`，面板关闭时再刷一次。用只读端点而不是回调，因为注册发生在 server 侧，拿不到浏览器里的实时状态
- **面板单实例**：同时只开一个；点空白 / Esc / 再点同一个都关

### UI 只有一种形状

`ui.page` / `slot` / `toolCard` / `headerAction` 都是"**地址 + 组件**"，装载路径完全一致：同源 URL → 动态 `import()` → `mount(el, host)`。差别只在**位置**：整页、页面里的一个坑、顶栏的一个按钮。

`ui.page` 还带一个 `nav?: boolean`（默认 `true`）：`nav: false` = **只登记路由、不占导航项**，用于"入口在别处但需要一个正式页面"——例如顶栏铃铛的面板里放「查看全部」跳到 `/notifications`，这样既不用在导航里再造一个同名入口，也有正式页可分享/刷新。

- 槽位名由**平台硬编码**（当前只有 `chat.rail.right`）：插件不能新造槽位，加槽位要改 UI 并发版
- 与内置路由冲突时插件页**不抢**：退回到 `/plugin-page/<pluginId>/<pageId>` 兜底路径
- 条件启用（按会话插件集过滤）只作用于 R9 / R10；R1–R8 是全局的

### 路由是段级模式，不是 glob

`:name` 匹配单段（值进 `request.params`）；`*` 只能作**最后一段**（匹配剩余全部，进 `params['*']`）。分发时**字面量永远优先于模式**（否则"注册顺序决定语义"，作者不可能猜对）。webhook 不需要专用机制：插件拿原始路径自己分发。

## 五个能力面（`host`）

插件访问平台的**唯一**通道 —— 不 import 内核模块，也不拿 `WorkerPool`（暴露 = 插件能杀进程）。

| 面 | 形状 | 说明 |
|---|---|---|
| `sessions` | `call` / `get` / `list` / `status` / `hasRow` / `subscribe` | **`call` 是唯一调用口**：平台方法 `prompt` / `abort` 与插件正向方法同一形状。`sessionId` 永远由调用方给（宿主不提供"选会话"） |
| `agents` | `list` / `get` / `update` | 插件维护自己的配置块 |
| `db` | `migrate` / `query` | 读写都开放；每次 query 进审计日志 |
| `lifecycle` | `onSessionCreated` / `onSessionDisposed` | 会话生命周期钩子 |
| `events` | `emit` | worker 侧可用；**server 侧本期未接通**（调用会 warn，明确告警而不是静默吞掉） |

内核侧（`packages/core/src/host-api.ts`）只声明**四个**面：`db` / `sessions` / `agents` / `lifecycle`。`web`（资源前缀）归入口的 HTTP 层，`events` 是出口而不是能力，`outbound` 属于注册面（变成 `methods.handle`）。

会话面与 agent 面一律返回 `Promise`（宿主机将来可能跨进程），`db` 面保持同步（DB 本来就是本进程的资源）。**除 `db.migrate`（内核 `initDb` 只建内核对象的表）之外，插件自己的表都要自己建。**

## 生命周期

```
装载：
  import(entry?v=<mtime>.<n>)          ← 破 ESM 缓存
  ↓ 断言注册表增量为 0                  ← 顶层零副作用（硬要求，机械校验）
  取默认导出的 { init, dispose? }
  ↓ init(host)                         ← 所有注册只能发生在这里
  菜单引用校验 / 反向方法 flush

卸载（reload / disable / 进程退出）：
  dispose?.()                          ← 可选，平台不等待/不重试/不校验结果
  ↓ 跑该插件的 disposer 账本（倒序）
  ↓ 断言账本归零（非零 → 记 error 并硬重置）
```

**每个注册/订阅都返回 disposer**，装载器按插件 id 记账。`reload` 就是"卸载 → 重新装载"，所以不需要重启 server：

```
pi-server plugin reload     # POST /api/extensions/reload
```

生效边界写在表里（见「四个装载点」）：server facet 立即、worker/pi 扩展等下次 spawn、浏览器刷新。

**不做目录监听**：插件**代码**变化不会被 registry 的文件监听捕获，用上面的命令手动触发。

## 两个目录：bundled 与用户插件

| 来源 | 位置 | 进 `registry.json`？ | 卸载方式 |
|---|---|---|---|
| bundled | `<安装根>/dist/server/plugins`（dev：`platform/plugins`） | ❌ 目录存在即生效 | **墓碑**（`removed: [{ id, removedAt }]`） |
| 用户 | `~/.pi/server/plugins`（dev：`platform/.dev-data/plugins`） | ✅ 只有这里登记 | 删条目（`--purge` 才删目录） |

`registry.json` 收窄成三行一件事：

```json
{ "version": 2, "plugins": [{ "id": "...", "dir": "...", "enabled": true }], "removed": [{ "id": "...", "removedAt": "..." }] }
```

版本 / 描述 / facet 声明一律从 `package.json` 与目录推导 —— 记在台账里就会过期。v1 结构读入时在内存里迁移，多余字段直接丢。

**卸载保留数据**：`plugin remove` 读 `plugin_migrations` 台账（`db.migrate` 时记 `(plugin_id, name)`），列出"留下的表"，**平台不自动删表**（不可逆且可能含真实数据）。

**dev 必须隔离**：`pnpm dev:server` 把插件目录 pin 到 `platform/.dev-data/plugins`。理由是 registry 带 `fs.watch` —— 共用一份文件时，你在 dev 停用一个插件，已安装实例会跟着重载（api 配置 / `mcp.json` / agents 目录没有监听与写回，不需要 pin）。

## 装载器实现要点（`services/plugin-extensions.ts`）

1. **零副作用断言**：`import()` 之后、`init()` 之前比较注册总数。捕获的是真实故障模式 —— 插件把 `host` 偷存到 `globalThis`，下次 reload 时顶层就能注册。
2. **cache bust**：`import('...?v=<mtimeMs>.<counter>')`。相对 import 按入口目录解析，不受 query 影响；counter 兜底同一毫秒内连续 reload。
3. **账本**：注册函数返回 disposer 并入库；卸载时倒序执行，再断言归零。
4. **无效注册一律进 `rejected`**（含原因与 `kind`），绝不静默丢弃；`registerError` 记录 init 抛错/超时。
5. **反向方法整块替换**：`WorkerPool.registerService` 先 `unregisterBySource` 再登记 —— 否则 reload 会撞 `name already registered`。

## 查询面

| 端点 | 内容 |
|---|---|
| `GET /api/plugins` | 静态事实（含 `source: bundled\|user`、状态、facet 探测结果） |
| `GET /api/plugins/:id` | 单插件详情（入口探测 / 依赖 / 关联台账条目） |
| `GET /api/plugins/:id/extensions` | 该插件的全部运行期注册（含 `rejected`） |
| `GET /api/extensions` | 全局：`pages`（**已摊平菜单字段**）+ 兼容用的 `menus` |
| `GET /api/sessions/:id/extensions` | 会话级：槽位 / 工具卡（按该会话插件集过滤） |
| `POST /api/extensions/reload` | 重装插件运行期（`plugin reload`） |
| `GET /api/p/<id>/*` | 插件 HTTP 端点（唯一分发器） |
| `GET /plugins/<id>/web/*` | 插件 web 资源（按**快照**解析目录，bundled 也覆盖） |

## 作者契约（要点）

- 每个 facet 文件 `export default { init(host), dispose?() } satisfies PluginDefinition`（纯对象；**顶层零副作用**）
- `package.json` 只留 `piServer.apiVersion` 与 `requires.plugins`：装载器要**不执行插件代码**就判掉不兼容版本 —— 版本号若在代码里，读它就得先 `import()`，那一刻顶层已经跑完了
- 类型是 **vendored 文件**（`plugin add` / `plugin check` 写进 `<插件>/types/plugin-types/`），不走 `peerDependencies`（`plugin-types` 是 private 包，npm 解析必然失败）
- 产物：原生 ESM、web 产物**无裸说明符 / 无 node 内建**、`mount(el, host)` 必须导出
- 机械校验：`pi-server plugin check <dir>`（入口存在 / ESM / 说明符 / web 产物），`plugin add` 自动调用

## 可执行验收

```bash
pnpm verify:plugins     # 进程内无 HTTP：装载 / 拒绝 / 分发 / 热加载 / 账本 / inline 工具白名单
pnpm verify:sdk         # 内核脱离入口独立运行
pnpm pack:cli           # 含 check-packaged：随包插件与 web 产物断言
```

`verify:plugins` 的六组断言就是本文的六条承诺：注册齐 · 拒绝可见 · 路由分发 · 热加载真生效 · 账本归零 · 顶层零副作用（外加 inline 工具的白名单语义）。

## 待决项

- **server 侧 `events`**：插件主动推 UI 本期未做。将来若需要，可能走"插件自己的 HTTP 路由 + SSE"，而不是新增能力面
- **插件目录监听**：本期靠 `plugin reload` 手动触发
- **`db.query` 全开放**：插件完全可信，已知可 `DROP TABLE`。缓解是审计日志；DDL 拦截留后续开关
- **bundled 改名/替换**：旧 id 的墓碑不做特殊处理（新 id 正常出现）
- **`capabilities/` 里的 `channel.*` / `config.*` 空占位**：im 搬走后归属待定（注册能力组 = 第七个面？还是删）
