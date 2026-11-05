# 插件运行期扩展点（注册式契约）

> 本文描述插件**如何向运行中的平台声明能力**，以及平台**在哪里、以什么顺序**消费这些声明。
> 安装、依赖闸门、目录探测、CLI 等不变的部分见 [`pi-agent-server_plugins.md`](pi-agent-server_plugins.md)；作者视角见 [`pi-agent-server_plugins-manual.md`](pi-agent-server_plugins-manual.md)。

## 一句话

插件在**三个入口**里声明能力：`register(host)`（声明界面要什么，server 执行）、`mount(el, host)`（渲染，浏览器执行）、`init(host)`（提供 HTTP 端点，server 执行）；平台把这些声明收进**一份内存注册表**，分四层查询。

## 三个入口

| 入口 | 谁执行 | 用途 | 禁区 |
|---|---|---|---|
| `register(host)` | **server** 进程，启动时装 | 注册菜单 / 页面 / rail 槽位 / 工具卡片 | 不许碰 DOM、不许阻塞 |
| `mount(el, host)` | **浏览器** | 渲染页面、槽位面板、工具卡片 | 无（这是 UI 本体） |
| `init(host)` | **server** 进程，启动时装 | 注册 HTTP 端点 | 不必碰 DOM，但 SHOULD 快速返回 |

一个 `web/index.js` 可以**同时**导出 `register` 与 `mount`：前者在 server 跑，后者在浏览器跑。

### 为什么 register 在 server 跑

注册表只有一份真相，落在 server 内存里 → 目录页、导航、会话页读的是同一来源。若让每个浏览器标签页各自执行 `register()`，会出现"三个标签各自看到不同插件贡献"，且"没打开过会话就看不到插件贡献"。

代价：`register()` 必须 DOM-free（无法静态强制，靠约定 + 失败可见）。

## 作用域在 API 形状里

```ts
interface PluginRegistrationHost {
  readonly id: string
  readonly dir: string          // 插件目录（可读文件）
  global: {
    menus:  { register(def: MenuRegistration): void }
    pages:  { register(def: PageRegistration): void }
    routes: { register(def: RouteRegistration): void }
  }
  session: {
    surfaces:  { register(def: SurfaceRegistration): void }
    toolCards: { register(def: ToolCardRegistration): void }
  }
  log(msg: string, extra?: unknown): void
}
```

`global` 是与会话无关的东西（菜单、页面、HTTP 路由）；`session` 是只在会话上下文里有意义的东西（rail 槽位、工具卡片）。

**为什么不给注册项加 `scope` 字段**：菜单永远不需要 `sessionId`、工具卡片永远需要——把这件事写进 API 形状，调用方写不错，读代码的人也一眼看出谁能用在哪。

**为什么 `routes` 只出现在 `init(host)`**：路由是 "服务器提供什么"，`register()` 只声明 "界面要什么"。分开之后，"有 web facet 才有 HTTP 端点"这种耦合不会出现。

## 四层查询

| 层 | 端点 | 内容 | 变化时机 |
|---|---|---|---|
| 静态事实 | `GET /api/plugins`、`/api/plugins/:id` | 安装目录、版本、`apiVersion`、`requires`、四个 facet 的目录探测与开关、装载状态 | 安装 / 启停 |
| 全局注册 | `GET /api/extensions` | 所有插件的 menus + pages（导航与页面路由用） | server 启动 |
| 单插件全集 | `GET /api/plugins/:id/extensions` | 该插件全部注册项 + `rejected` + `registerError` | 同上 |
| 会话级 | `GET /api/sessions/:id/extensions` | 该会话生效的 surfaces + toolCards（经闸门过滤，每项带 `deniedReason`） | 会话创建 / 开关变化 |

**静态接口里绝不含注册项**。这是本轮最明确的边界：`/api/plugins` 回答"装了什么"，`/api/extensions` 回答"跑起来之后声明了什么"。

`GET /api/sessions/:id/plugins` 保留，但只讲闸门事实（哪些插件对该会话启用、为什么没启用），不再带槽位。

## 插件 HTTP 端点：固定分发器

平台在启动时注册**唯一一条**路由：

```
app.all('/api/p/:pluginId/*', dispatchPluginRoute)
```

请求进入后：查 `enabled` → 查该插件的路由表 → 按 `method` + `path` 匹配 → `try/catch` → 404 / 500。插件看到的 `c.req.path` 已剥掉 `/api/p/<id>` 前缀。

**为什么不能 `app.route()`**：Hono 的路由表在**首次请求后冻结**（`app.all(...)` 之后再 `addRoute` 会抛 `MESSAGE_MATCHER_IS_ALREADY_BUILT`）。插件是运行期装载的，必然晚于首次请求。

**已知代价**：插件路径必须精确声明，不能用通配符（`/files/*` 这类需要自己在 handler 里解析尾部路径）。前缀与插件 id 绑定，注册别人的路径不可能。

响应可返回 JSON / 文本；二进制需自行设置 `Content-Type` 与 `BodyInit`。

## 菜单与页面

菜单**不进 Vue Router**：`nav-tree` 的 `computed` 读 `router.getRoutes()`，而路由表变化不触发重算（非响应式依赖）。

做法：插件菜单进独立响应式注册表，`nav-tree` 把"路由推导的一级项"与"插件注册的一级项"合并输出。点击 → 平台静态路由 `/plugin-page/:pluginId/:pageId`，由参数决定渲染谁。

本期唯一开放的二级挂载点是 `config`（`parent: 'config'` 合入 `CONFIG_SECTIONS`）。其它 parent 值 → 拒绝并记 `rejected`。

## 工具卡片：两种模式

```js
host.session.toolCards.register({ tool: 'sendFileToUser', mode: 'replace', entry: 'card' })
host.session.toolCards.register({ tool: 'mcp__rea__', match: 'prefix', mode: 'regions', regions: { footer: 'foot' } })
```

| 模式 | 插件拿到什么 | 平台保留什么 |
|---|---|---|
| `replace` | 整卡容器（含头部） | 折叠态记录、卡片外层布局 |
| `regions` | 指定区域（`header`/`body`/`footer`） | 头部、折叠交互、未声明区域 |

`regions` 存在的理由：多数需求是"在现有卡片上加一行/一张图"，强制整卡重写会逼插件复刻流式渲染、错误展开、拖拽点击阈值——成本与一致性双输。

`replace` 想复刻平台观感时，可选调用 `host.ui.toolCardShell()` 拿到平台的头部与折叠行为。

同一工具同一区域重复注册 → 后者 `rejected`，先注册者生效。

## 装载顺序

```
1. 扫描插件目录 → 静态事实（facet 目录探测、开关、依赖）
2. 对 enabled 且通过 apiVersion / requires 闸门的插件：import web/index.js → register(host)
3. 对 enabled 且有 server facet 的插件：import server/index.js → init(host)
4. 注册分发器 /api/p/:pluginId/*
```

`enabled: false` 的插件**一行代码都不执行**（不 import）。`register()` 抛错 → 该插件标记 `registerError`，其余插件照常装载，平台不崩。

`register()` 有超时保护：超时后放弃该插件注册项并标记原因（同步死循环无法被 `Promise.race` 打断，属已知边界）。

## 无效注册必须可见

三条规则，一条都不许静默：

| 情况 | 结果 |
|---|---|
| 未知槽位名 / 未知 parent / 未知 region | 该注册项进 `rejected`（带期望值与原因） |
| id 冲突 | 后者进 `rejected`，先注册者保持 |
| `register()` 抛错 / 超时 | 整个插件标 `registerError`（含消息与堆栈首行） |

全部通过 `GET /api/plugins/:id/extensions` 暴露，并在目录页详情里展示。

## 信任边界

插件代码在 server 主进程执行，与平台同权（可读任意文件、可起定时器）。**装插件 = 授权在本机跑代码**。平台本身无鉴权（单用户本地服务），`enabled: false` 或 `PI_PLUGINS=0` 是唯一 kill switch。

## 声明式只剩闸门

`package.json` 的 `piServer.web.surfaces[]` 已移除。剩下的平台字段只有两个，且都在**执行插件代码之前**要读：

| 字段 | 作用 |
|---|---|
| `piServer.apiVersion` | 兼容性闸门（不匹配 → 跳过，不执行） |
| `piServer.requires.plugins` | 依赖闸门（缺失或不满足 → 跳过，可被全局 override 强制启用） |
