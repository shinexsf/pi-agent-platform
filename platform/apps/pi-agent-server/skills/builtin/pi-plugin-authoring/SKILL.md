---
name: pi-plugin-authoring
---

# 给平台写插件

平台插件 = 一个**目录**（`~/.pi/server/plugins/<id>/`）+ 一条安装事实（`registry.json`）。它不是一个 npm 依赖，也不热加载。

## 0. 先读能跑的示例（比本文档更可信）

本 skill 目录下带了两份**可直接安装**的示例（无依赖、无构建、纯 ESM JS），相对本文所在目录：

| 示例 | 是什么 | 想回答的问题 → 读哪个文件 |
|---|---|---|
| `examples/hello-plugin/` | 最小可运行：配置二级页 + 一个 GET 端点 | `package.json`（manifest 最小集）· `server/index.js`（菜单/页面/路由注册）· `web/page.js`（`mount` 与 dispose） |

试装（把示例目录复制出仓库再装，别直接装在 skill 目录里）：

```bash
cp -r examples/hello-plugin /tmp/demo-hello-plugin
pi-server plugin add /tmp/demo-hello-plugin
pi-server restart
```

插件 id 用 `@scope/name` 也可以（示例就是 `@demo/hello-plugin`）：`host.api.*` 会把 id 编码进 URL，平台侧能正确解出来。

改完代码必须 `pi-server restart`（v1 不热加载）。示例里的注释就是文档——**动手前先读对应文件**，本文只补它没说的边界与坑。

## 1. 先选形态：你要加的是哪种东西

| 想加的东西 | 去哪 | facet |
|---|---|---|
| 一级/配置二级菜单项、插件页 | `server/index.js` 的 `init(host)` 注册，页面内容放 `web/<entry>.js` | server + web |
| HTTP 端点 | `server/index.js` 的 `init(host)` → `host.global.routes` | server |
| 会话页右侧轨道按钮 + 抽屉面板 | `server` 注册 surface，`web/<entry>.js` 的 `mount` | server + web |
| 接管/替换某个工具的卡片渲染 | `host.session.toolCards` + `web/<entry>.js` | server + web |
| 给 agent 加工具 / 拦截工具调用 | pi 扩展写法（`extension/index.js`）或 worker `activate` | extension / worker |
| 会话内的自定义上行事件（worker → 浏览器） | `worker/index.js` 的 `activate({ bridge })` → `bridge.emit` | worker |

一句话判断：**"服务器提供什么"用 server facet；"界面长什么样"必须落在 web facet；"会话里发生什么"用 worker/extension facet。**

## 2. 目录与 manifest

```
~/.pi/server/plugins/@me/hud-demo/
├── package.json          ← 安装事实 + 兼容性闸门（必需）
├── server/index.js       ← facet（可选，目录存在即声明）
├── worker/index.js       ← facet（可选）
├── extension/index.js    ← facet（可选）
└── web/panel.js          ← web facet 的入口文件（entry 对应文件名）
```

```json
{
  "name": "@me/hud-demo",
  "version": "0.1.0",
  "description": "在会话右侧显示一个 HUD",
  "piServer": { "apiVersion": "1" }
}
```

- `piServer.apiVersion` **必需**，不匹配（或缺失）→ 整包跳过，状态 `degraded`，原因可在插件页看到。
- 依赖别的 pi 插件时：`piServer.requires.plugins` 与 `peerDependencies` **两处都要写**（前者是校验，后者是代码 import 的前提）；平台只**校验**，绝不代用户启用。
- **界面贡献不写在 package.json 里**——所有 UI/端点都在运行期注册（见 §3）。package.json 只表达安装事实与兼容性。

安装（没有网页按钮，安装是 CLI 的事）：

```bash
pi-server plugin add <目录>          # 装即启用（没有 --enable 这个 flag）
pi-server plugin list
pi-server plugin enable|disable <id>
pi-server plugin remove <id> [--purge]
```

## 3. 扩展点清单

`server/index.js`（默认导出 `init`，**只在这里注册**）：

```js
export function init(host) {
  // 一级菜单 + 页面（page 指向 pages 里的 id）
  host.global.menus.register({ id: 'hud-demo', label: '演示页', page: 'about', order: 1050 });
  host.global.pages.register({ id: 'about', entry: 'page' });          // → web/page.js
  // 配置二级菜单：parent: 'config'
  // HTTP 端点（挂在 /api/p/<pluginId>/ 下，精确匹配，不支持通配符）
  // handler 收到 { method, path, query, body(原始文本), header(name) }，返回 { status?, headers?, json? | body? }
  // ⚠️ 不是 Hono 的 c.json()——平台不分发 Hono context
  host.global.routes.register({ method: 'GET', path: '/echo', handler: (req) => ({ json: { ok: true, query: req.query } }) });
  // 会话页槽位（目前唯一槽位 chat.rail.right = 轨道按钮 + 抽屉）
  host.session.surfaces.register({ id: 'hud', slot: 'chat.rail.right', title: 'HUD', icon: 'layers', entry: 'panel' });
  // 工具卡片：mode: 'replace' 整卡替换 / 'regions' 只换 header|body|footer
  host.session.toolCards.register({ tool: 'sendFileToUser', mode: 'replace', entry: 'card' });
  // 触发器：进程内触发 / 列出 / 注册新来源
  host.log('info', 'hud-demo ready');
}
```

`web/<entry>.js`（浏览器侧，注册与挂载完全运行期）：

```js
export function mount(el, host) {
  const off = host.data.subscribe(({ name, data }) => { /* worker 上行事件 */ });
  el.textContent = `plugin ${host.pluginId}`;
  return () => off();            // 必须返回 dispose：停推 → dispose → 移除 el
}
```

`worker/index.js`（会话进程内，`activate({ bridge })`）：

```js
export async function activate({ bridge }) {
  bridge.emit('hello', { at: Date.now() });            // → 浏览器（SSE plugin 事件，无回执）
  bridge.registerMethod?.('emit', ({ name, data }) => {  // ← 注册为 plugin.<id>.emit，有回执
    /* master / 浏览器下行调用 */
    return { ok: true };
  });
  await bridge.call?.('plugin.im.sendFile', [{ filePath: '/tmp/a.png' }]); // → master 反向方法
  bridge.log('info', 'worker facet loaded');
}
```

`extension/index.js`（作为 **pi 扩展**装载，能注册工具/命令/钩子；注意第一个参数是 `pi`，`bridge` 在第二个）：

```js
export default async function extension(pi, { bridge }) {
  pi.registerTool({
    name: 'demo_echo',
    label: 'Demo Echo',
    description: '回声工具',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: async (_id, params) => {
      bridge.emit('tool_called', { text: params.text });
      return { content: [{ type: 'text', text: `echo: ${params.text}` }], details: {} };
    },
  });
}
```

浏览器宿主的常用面：`host.data.subscribe/emit`、`host.api.get/post/put/del/blob`（只会打到你自己前缀 `/api/p/<pluginId>/`）、`host.ui.sheet/toast`、工具卡片专属 `host.toolCard`（`call` / `subscribe(fn)` / `shell()`）。主题只保证约定 CSS 变量在 `el` 祖先链上，**不要写全局样式、不要 teleport 到 `el` 之外**。

## 4. 硬约束（这些不是风格建议）

2. **路由路径精确匹配**，不支持通配符；请求体是**原始文本**，要 JSON 自己 `JSON.parse`。
3. **facet 靠目录存在声明**；没实现能力的 facet 不要建空目录。
4. **注册项 id 同（作用域, 类别）唯一**；重复注册后者被拒，进 `rejected`——**被拒绝不静默**，一定要在 `/api/plugins/:id/extensions` 里能看见。
5. **不做热加载**：改代码后 `pi-server restart`；worker/extension facet 的变更对已在跑的会话要等下次 spawn。
6. **peer 依赖不装副本**：插件目录里不要自带一份 `@earendil-works/pi-coding-agent` 之类的副本。
7. **浏览器侧数据单向上行**：worker → server → SSE；不要从 server 主动推浏览器。

## 5. 最小可运行示例（完整代码见 `examples/hello-plugin/`）

```
hello-plugin/
├── package.json               { "name":"...","version":"0.1.0","piServer":{"apiVersion":"1"} }
├── server/index.js            init(host) → 注册菜单 / 页面 / 路由
└── web/page.js                mount(el, host) → 返回 dispose
```

```js
// server/index.js
export function init(host) {
  host.global.menus.register({ id: 'hello', label: 'Hello', page: 'hello' });
  host.global.pages.register({ id: 'hello', entry: 'page' });
  host.global.routes.register({ method: 'GET', path: '/whoami', handler: () => ({ json: { plugin: host.id } }) });
}

// web/page.js
export async function mount(el, host) {
  const me = await host.api.get('/whoami');
  el.textContent = `plugin=${me.plugin}`;
  return () => {};
}
```

```bash
pi-server plugin add ./@me/hello --enable
pi-server restart
```

## 6. 自测（装完怎么看它对不对）

| 想知道 | 看哪里 |
|---|---|
| 装上了吗、为什么没生效 | `GET /api/plugins`（状态 / version / detail / declared） |
| 我的注册项进去了吗、被拒了几条 | `GET /api/plugins/:id/extensions`（含 `rejected` 与 `registerError`） |
| 菜单/页面/路由有没有生效 | `GET /api/extensions`（全局聚合，web 菜单的唯一来源） |
| 会话级槽位/工具卡片生效了吗 | `GET /api/sessions/:id/extensions` |
| 运行时报错 | 平台日志里带 `pluginId` 的行；facet 抛错只隔离自己，不影响会话 |

验证顺序建议：`plugin list` 状态 → `/api/plugins/:id/extensions` 有 `rejected` 先修 → `/api/extensions` 有菜单 → 浏览器打开页面看 console。

## 7. 常见反模式

- ❌ 在 `register()`/运行期注册路由（会抛错，且错误只在 `registerError` 里）
- ❌ 在 package.json 里声明 UI（平台不读，界面贡献只能运行期注册）
- ❌ `mount` 不返回 dispose / 跳过子元素清理（切页后泄漏）
- ❌ 在 web facet 写全局 CSS 或 `document.body` 级操作（只允许动自己的 `el`）
- ❌ 在 worker facet 里做阻塞式初始化（会拖慢会话启动）
- ❌ 直接读写平台数据库或猜内部端点（插件只用 `host` 契约与自己的 `/api/p/<id>/*`）
- ❌ 照抄 Hono 写法 `handler: (c) => c.json(...)`（平台给你的是 `PluginRouteRequest`，返回 `{ json }`）
- ❌ 把 `extension/index.js` 写成 `({ bridge }) => ...`（签名是 `(pi, { bridge })`）
- ❌ 改完插件不重启就断言"没生效"（v1 不热加载）
