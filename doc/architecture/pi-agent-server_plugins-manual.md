# 插件使用手册（写一个平台插件）

> 面向**插件作者**。想知道为什么这样设计、内部怎么装载 → 看 [插件机制架构](pi-agent-server_plugins.md)。
> 本文只讲：写出来、装进去、跑起来、出问题怎么查。

## 0. 三十秒上手

最小可用插件 = 一个目录 + 一个 `package.json` + 一个**注册脚本**（server 进程执行）+ 一个浏览器入口。

```
~/my-plugin/
├── package.json
└── web/
    ├── index.js          # register(host)：在 server 进程里注册槽位
    └── panel.js          # mount(el, host)：在浏览器里渲染
```

```json
{
  "name": "@me/hello",
  "version": "0.0.1",
  "type": "module",
  "piServer": { "apiVersion": "1" }
}
```

```js
// web/index.js —— 跑在 server 进程里（不碰 DOM）
export function register(host) {
  host.session.surfaces.register({ id: 'hello', slot: 'chat.rail.right', entry: 'panel', title: 'Hello', icon: 'plug' });
}
```

```js
// web/panel.js —— 跑在浏览器里，不用构建、不用打包
export function mount(el, host) {
  el.innerHTML = '<div style="padding:12px">hello, 这是会话 ' + host.sessionId.slice(0, 8) + '</div>';
  return () => { el.innerHTML = ''; };   // 清理：抽屉关闭时调用
}
```

安装并刷新页面：

```bash
pi-server plugin add ~/my-plugin --enable
```

会话页右上角轨道出现按钮 → 点开抽屉就是你的面板。**注册是启动期一次性**：改 `register()` 需要重启 server；改 `mount()` 刷新页面即可。

## 1. 目录与 manifest 参考

```
~/.pi/server/plugins/<id>/          ← id 就是 package.json 的 name（@scope/name 有子目录）
├── package.json
├── server/index.js                 ← 可选：跑在主进程
├── worker/index.js                 ← 可选：跑在 session worker 里（直接拿 SDK）
├── extension/index.js              ← 可选：以 pi extension 身份装载（最常用）
└── web/<entry>.js                  ← 可选：跑在浏览器
```

`piServer` 的全部字段（**只有安装事实与兼容性闸门，没有界面声明**）：

| 字段 | 必填 | 说明 |
|---|---|---|
| `apiVersion` | ✅ | 当前只能是 `"1"`。缺失或不匹配 → 整包跳过（`status: degraded`，原因可查） |
| `requires.plugins` | — | `{ "包名": "semver range" }`。**只校验**：未安装、或该 agent 没在 `extensions` 里启用它 → 本插件不加载。**它绝不会帮用户开启依赖** |

界面贡献（菜单、页面、槽位、工具卡片）与 HTTP 端点**全部在代码里注册**，见 2.4 / 4.x 节。

**依赖 pi 插件时**，代码要 `import` 它，所以同样的包名必须出现在 `peerDependencies`（安装时不做真实解析，但它是契约的一部分）：

```json
{
  "peerDependencies": { "billion-context-pi": ">=1.0.0" },
  "piServer": { "apiVersion": "1", "requires": { "plugins": { "billion-context-pi": ">=1.0.0" } } }
}
```

## 2. 四种 facet

按**跑在哪**分，不是按功能分。四个都可以有，也可以只有一个。

### 2.1 `web` —— 浏览器里的面板

```js
export function mount(el, host) { /* ... */ return dispose; }
```

`host` 提供（详见第 3 节）：`sessionId` · `data.subscribe` · `api.post` · `theme.get/subscribe` · `log`。

规则：

- 所有 DOM 必须落在 `el` 里面（**不许 teleport** 到 body 或别的容器）
- **不许写全局 CSS**（`body {}`、`* {}`、`:root {}` 都算越界）；要配色就用 `host.theme` + 白名单变量
- 返回的 `dispose` 在抽屉关闭/切换会话时调用；关闭顺序是「停推数据 → dispose() → 移除 el」

### 2.2 `extension` —— 以 pi extension 身份加工具（主力形态）

写法和原生 pi 扩展**完全一样**，只多一个可选的第二个参数 `{ bridge }`：

```js
// extension/index.js
export default async function ({ bridge } = {}) {
  return {
    name: 'hello-tools',
    factory: (pi) => ({
      tool: () => ({
        name: 'hello_ping',
        description: 'Ping the platform UI',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          bridge?.emit('ping', { at: Date.now() });   // 推到浏览器面板
          return { content: [{ type: 'text', text: 'pong' }] };
        },
      }),
    }),
  };
}
```

> 平台在 `additionalExtensionPaths` 里注入一层 **inline 包装模块**给你塞 `bridge`：所以你既可以用标准 pi 扩展签名，也能拿到上行桥。代价只是调用栈多一层。
> 注意：**没有启用 bridged 模式时 `bridge` 是 `undefined`**，用 `bridge?.emit` 保底。

### 2.3 `worker` —— 直接跑在 session worker 里

```js
// worker/index.js
// 入口是 `export default` 或 `export function activate(ctx)`，ctx = { bridge }
export default function activate({ bridge }) {
  bridge.onEmit?.(async (name, data) => {
    if (name === 'ping') bridge.emit('pong', { got: data, at: Date.now() });
  });
  return () => {};   // 可选清理
}
```

> **worker facet 拿不到 `pi` 实例**——它是"同进程的旁观者"，只能通过 `bridge` 收发。要挂 `pi.on(...)` 钩子或注册工具，用 `extension` facet。

什么时候选 `worker` 而不是 `extension`：你需要不被 pi extension 装配顺序影响地持有长生命周期状态，并且只靠事件就能工作。

### 2.4 `server` —— 主进程里的注册器（菜单 / 页面 / 端点 / 槽位 / 工具卡片）

```js
// server/index.js
export function init(host) {                       // host.id / host.dir / host.log
  host.global.menus.register({ id: 'demo', label: '演示页', page: 'about', order: 1050 });
  host.global.pages.register({ id: 'about', title: '演示页', entry: 'page' });
  host.global.routes.register({ method: 'GET', path: '/echo', handler: (c) => c.json({ ok: true }) });
  host.session.surfaces.register({ id: 'hud', slot: 'chat.rail.right', title: 'HUD', icon: 'layers', entry: 'panel' });
  host.session.toolCards.register({ tool: 'sendFileToUser', mode: 'replace', entry: 'card' });
}
```

- **`init` 在 server 进程执行**（不是浏览器），因此不能碰 `document`/`window`；浏览器部分的代码放在 `web/` 里，由 `mount` 自己跑
- **作用域写在 API 形状里**：`host.global.*`（菜单/页面/路由）与 `host.session.*`（槽位/工具卡片）；会话级注册项会带上 `sessionId` 下发
- **注册是启动期一次性的**：改 `register()`/`init()` 需要重启 server；运行期只读
- 注册失败（未知槽位、id 冲突、抛错、超时）不静默——进 `rejected` / `registerError`，在配置页「平台插件」详情里能看到原因

## 2.5 三个入口的职责划分

| 文件 | 导出 | 跑在哪 | 干什么 |
|---|---|---|---|
| `server/index.js` | `init(host)` | server 主进程 | 注册一切（菜单/页面/端点/槽位/卡片） |
| `web/index.js` | `register(host)` | **也跑在 server** | 只注册 `web.surfaces` 类贡献（现等价于 `init` 里的 session.surfaces） |
| `web/<entry>.js` | `mount(el, host)` | 浏览器 | 渲染自己的 DOM |

`web/index.js` 的 `register` 与 `server/index.js` 的 `init` 拿到的是**同一个 host**（`id` / `dir` / `global` / `session` / `log`），区别只在**阶段**：`routes.register` 在 `register()` 阶段会被拒（"路由只能在 init(host) 里注册"），其余注册器两个阶段都能用。两者都有 **5 秒执行上限**，超时/抛错都会回收该插件的全部注册项（`rollbackPlugin`），避免"半个菜单 + registerError"的自相矛盾。

## 3. 三个宿主 API 一览

### `PluginWebHost`（web facet）

| 成员 | 说明 |
|---|---|
| `sessionId` | 只读会话 id |
| `data.subscribe(fn)` | 收 worker/extension 侧 `bridge.emit` 的数据。**载荷是冻结的普通 JSON**（不是 Vue 响应式对象），要渲染自己转一层 |
| `api.post(path, body)` | 调**你自己前缀**下的 REST（相对 `/api/p/<pluginId>/`）；未注册该路径 → 404 |
| `theme.get()` / `theme.subscribe(fn)` | `'light' \| 'dark'`；配色只用白名单变量：`--bg` `--surface` `--fg` `--fg-dim` `--border` `--accent` `--ok` `--warn` `--err` |
| `log(level, msg)` | 进平台日志（自动带 pluginId） |

### `PluginWorkerBridge`（worker / extension facet）

| 成员 | 说明 |
|---|---|
| `pluginId` | 只读 |
| `emit(name, data)` | **上**行：worker → 浏览器。经 SSE 固定事件名 `plugin`，载荷 `{ pluginId, name, data }` |
| `onEmit(handler)` | **下**行：浏览器 → worker。**同一插件只保留最后一个处理器** |
| `log(level, msg, extra?)` | 进平台日志 |

### 硬上限（超了会被截断/丢弃，记一条 warn）

- 单条载荷 > **64 KiB** → 截断
- 每会话每秒 > **100 条** → 丢弃
- 日志**只记** pluginId / name / 字节数，不落原始载荷

## 4. 槽位与 mount 协议

| 槽位 | 位置 | 说明 |
|---|---|---|
| `chat.rail.right` | 会话页右上角 icon 轨道 | 每个面 → 一个按钮；点击展开该插件的抽屉，内容为 `web/<entry>.js` 的 `mount` |

```js
// server/index.js —— 注册
host.session.surfaces.register({ id: 'hud', slot: 'chat.rail.right', title: 'HUD', icon: 'layers', entry: 'panel', order: 10 });
```

- 资产由 server 同源托管：`GET /plugins/<id>/web/<file>`。插件自己 import 的第三方库要么用 CDN，要么装进插件目录的 `node_modules`（`plugin add` 会原样复制）
- 路径穿越与扩展名白名单双向校验；`id` 从 registry 的 `dir` 解析（不是字符串拼接）
- **一个槽位就是一个入口**：按钮由宿主渲染，抽屉内容是同一 `entry` 的 `mount(el, host)`；插件不需要为抽屉再声明一次槽位（`el.dataset.slot` 恒为 `'chat.rail.right'`）
- 未知槽位名会被拒（进 `rejected`），不会静默丢弃
- 宿主给你的 `el` 上是 `div.plugin-surface`，带 `data-plugin-id` 与 `data-slot`；这就是你全部能碰的外部状态

## 4.5 页面、菜单与 HTTP 端点

```js
host.global.menus.register({ id: 'demo', label: '演示页', page: 'about', order: 1050 });   // 出现左侧导航
host.global.pages.register({ id: 'about', title: '演示页', entry: 'page' });              // 路由 /plugin-page/<id>/about
host.global.routes.register({ method: 'GET', path: '/echo', handler: (c) => c.json({ ok: true }) });  // → /api/p/<id>/echo
```

- 菜单项必须有对应 `page`；没有会进 `rejected`
- 页面路由是**平台 router 里的一条静态路径**（`/plugin-page/:pluginId/:pageId`），`entry` 指向 `web/<entry>.js`
- 端点挂在 `/api/p/<id>/` 下，由启动时注册的**唯一一条分发器**承载（Hono 路由表首次请求后冻结，不能在运行期追加）；`c.req.path` 已剥离前缀
- 端点没有鉴权（与平台其它 REST 一致）

## 4.6 工具卡片

```js
host.session.toolCards.register({ tool: 'sendFileToUser', mode: 'replace', entry: 'card' });
host.session.toolCards.register({ tool: 'mcp__rea__', match: 'prefix', mode: 'regions', regions: { footer: 'foot' }, entry: 'foot' });
```

| `mode` | 你负责 | 平台负责 |
|---|---|---|
| `replace` | 整张卡片（含头部） | 容器与错误降级 |
| `regions` | 声明的区域（`header`/`body`/`footer`） | 其余区域、折叠/展开交互 |

`mount` 的 `host` 额外有 `call`（冻结快照：`toolName`/`args`/`result`/`isError`/`images`/`durationMs`）与 `subscribe`（流式更新）；可用 `host.ui.toolCardShell()` 复用平台头部与折叠。

## 5. 会话维度：谁能看到你的插件

两层语义，别混：

| 层 | 谁决定 | 效果 |
|---|---|---|
| **全局开关** | `registry.json` 的 `enabled` / `facets.*`（CLI `enable` / `disable`） | 关掉 → 任何会话都不加载 |
| **会话闸门** | 该会话 agent 的 `extensions` 白名单 × 你声明的 `requires.plugins` | 依赖没启用 → **这个会话**不加载你，`reason: 依赖未启用: xxx` |

浏览器侧槽位是**按会话拉取**的（`GET /api/sessions/:id/plugins`），所以：会话 A 的 agent 启用依赖 → 图标在；会话 B 没启用 → 图标不出现。这不是前端隐藏，是服务端根本不下发。

## 6. 调试手册

```bash
pi-server plugin list                 # id / version / status / facets / 失败原因
pi-server plugin list --json
pi-server plugin enable|disable <id>
pi-server plugin remove <id> [--purge]   # --purge 同时删目录
pi-server plugin add ./pkg --enable      # 复制目录 + 写 registry
```

| 现象 | 先看这里 |
|---|---|
| 图标没出现 | `GET /api/sessions/<id>/plugins` 里有没有它 → 没有就是闸门拦了（看 `reason`）；有但不显示 → 前端槽位挂载失败，看浏览器 console |
| `status: degraded` | `GET /api/plugins` 的 `reason`：`apiVersion` 不对 / 目录缺 `package.json#piServer.apiVersion` / facet 声明了但缺入口文件 |
| 抽屉报「插件加载失败」 | web 入口 404 或 `mount` 抛异常；`/plugins/<id>/web/<entry>.js` 手动打开试试 |
| 面板收不到数据 | `bridge.emit` 是否真的调用（worker 日志）；`onEmit` 是否在 `activate` 里注册；检查 64 KiB / 100fps 上限 |
| 改了代码不生效 | v1 **没有热加载**：`pi-server restart`。web 侧刷新页面即可 |
| 想看每个会话的闸门解释 | `GET /debug/sessions/<id>`（dev 模式）→ `plugins[]` 每条的 `issues[].reason` |

**坏插件不会拖垮别人**：`mount` 抛错只影响自己那个槽位（抽屉里显示失败原因 + 一条 console 错误）；extension/worker facet 抛错会记 `facet failed to load (session continues)`，会话照跑。

### 6.1 用配置页「平台插件」看自己提供了什么

`配置 → 平台插件`（`/config/plugins`）是自查第一站，**只读**：

- **列表**：`id / 版本 / status / 描述 / 扩展点徽标 / 依赖摘要`。扩展点徽标有四态：`✓`（会执行）、`已关`（开关关掉）、`入口缺失`（目录在、入口文件没了）、`未装载`（平台没实现，如 `server`）、`未登记`（目录在但 registry 没登记）
- **详情**：扩展点四态表（声明 / 开关 / 入口路径 / 是否装载）；依赖的 pi 插件三态（`✓ 已安装` / `✗ 未安装` / `? 未知`）；`web` 槽位表；底部等价 CLI 命令

排查思路：

| 你在页面上看到 | 说明 | 怎么办 |
|---|---|---|
| 插件根本没出现 | registry 里没有它（`orphan` 会显示但标"未登记"） | `pi-server plugin add ./pkg --enable` |
| `worker 入口缺失` | 目录有、`worker/index.js` 没有（或只编到了 `dist/` 下且路径对不上） | 补齐入口文件；期望路径在详情里 |
| `server 未装载` | 已装载（`init(host)`）；若仍显示未装载，看 `registerError` | 检查 `server/index.js` 是否导出 `init` 或 default 函数 |
| 依赖 `✗ 未安装` | pi 侧没有这个插件，会话闸门会拦 | `pi install <pkg>` 并把它加进 agent 的 `extensions` |
| 依赖 `? 未知` | `~/.pi/agent/settings.json` 读不出来 | 查权限/JSON 语法 |
| `status: active` 但会话里没效果 | `active` 只代表静态检查通过 | 去 `GET /debug/sessions/<id>` 看 `plugins[].reason` |

## 7. 打包与分发

- 纯 JS 即可，**不需要构建**；需要 TS 就自己先编成 `web/*.js`、`*/index.js`
- 装到别的机器：`pi-server plugin add <目录>`；跨机器分发用目录打包（tgz/zip）后解压再 add
- `pi-server plugin add <npm 包名>` 走 `npm pack`，在部分 Node 版本上会因类型剥离限制失败——**先本地 npm install 再 add 目录**更稳
- 打包态（容器/正式包）里插件目录是 `~/.pi/server/plugins/`，与 dev 共用同一套路径

## 8. 已知坑（踩过的）

| 坑 | 说明 |
|---|---|
| `entry` 与文件名不符 | `entry: "panel"` 必须对应 `web/panel.js`，写成 `web/panel/index.js` 不行 |
| 在 `mount` 外缓存 `el` | 抽屉关闭会换元素；不要在模块级存 DOM 引用 |
| 用全局事件总线通信 | 禁止（不变量 5）；插件之间要走平台事件或各自 `api` |
| 在 extension facet 里 import 别的 pi 插件 | 用 `requires.plugins` 声明依赖，别去 `node_modules` 里 direct import——那是平台负责解析的 |
| 指望 `requires.plugins` 会「顺手启用」依赖 | 不会。依赖必须在该 agent 的 `extensions` 里，否则插件不加载 |
| 面板数据带不进压缩后的历史 | 若你需要「压缩后的投影」，必须自己读压缩块（例如 sidecar）；平台不下发加工后的历史 |
| `PI_PLUGINS=off` | 应急开关：registry 仍可读，所有插件 `status: disabled`，平台自身功能不受影响 |

## 9. 完整参考示例

仓库里 `plugins/` 是**本地**插件区（gitignored），验证插件机制时用的三个真实例子：

| 插件 | 位置 | 演示什么 |
|---|---|---|
| `@probe/hud-demo` | `~/.pi/server/plugins/`（本机） | 最小四件套：rail + drawer + worker `onEmit` 回显 + extension 加工具 |
| `@probe/hud-pack` | 同上 | 打包态（容器里）下的同一形态 |
| `@platform/session-projection` | 仓库 `plugins/session-projection/` | 真实场景：extension facet 用 `pi.on('context')` 抓发给模型的消息数组，web facet 按序渲染成「messages 视图」 |

`@platform/session-projection` 是照着本手册写出来的，可以直接当模板抄。
