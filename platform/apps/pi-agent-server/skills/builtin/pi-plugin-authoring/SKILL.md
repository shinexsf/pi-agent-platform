---
name: pi-plugin-authoring
description: 给 pi-agent-platform 写插件时读这份。讲 v2 契约：目录约定、四个装载点的默认导出写法、五个能力面、vendored 类型、`plugin check` 自查、产物硬约束（原生 ESM、无裸说明符）、常见坑。
---

# 给平台写插件

> 契约的权威描述在仓库文档：`doc/architecture/pi-agent-server_plugins-manual.md`（作者契约）
> 与 `pi-agent-server_plugins-runtime.md`（运行期机制）。本 skill 是**动手版**，示例代码可直接跑。

## 0. 先读能跑的示例（比本文档更可信）

| 示例 | 覆盖 | 位置（相对仓库根） |
|---|---|---|
| `hello-plugin` | 最小集：server facet + 一个页面 | `platform/apps/pi-agent-server/skills/builtin/pi-plugin-authoring/examples/hello-plugin/` |
| `kitchen-sink` | 四个装载点全景（server/worker/extension/web），工具 / 命令 / 钩子 / 槽位 / 工具卡 / 反向方法 | `.../examples/kitchen-sink/` |

装进运行中的实例试：

```bash
pi-server plugin check <示例目录>     # 机械校验（顺手写类型）
pi-server plugin add <示例目录>       # 登记 + 装载
pi-server plugin reload               # 已装过、改了代码时用这个（不重启 server）
```

## 1. 先选形态：你要加的是哪种东西

| 想做的事 | 写在 | 用哪个扩展点 |
|---|---|---|
| 加个配置页 / 一级页面 | `server/index.js` + `web/page.js` | R1 `host.ui.page` |
| 在会话页右侧轨道塞个面板 | 同上 + `web/panel.js` | R9 `host.ui.slot` |
| 接管某个工具的卡片渲染 | `server/index.js` + `web/card.js` | R10 `host.ui.toolCard` |
| 提供 HTTP 端点（webhook / 回调） | `server/index.js` | R2 `host.http.route` |
| 让 worker 能反向调我 | `server/index.js` | R3 `host.methods.handle` |
| 建自己的表 | `server/index.js` | R4 `host.db.migrate` |
| 让 master/浏览器能调会话里的我 | `worker/index.js` | R5 `host.methods.handle` |
| 给 agent 加工具 / 命令 / 钩子 | `extension/index.js` | R6–R8 pi 原生面 |

**定时器不在扩展点清单里**：在 `init()` 里自己起，平台不管调度、不补跑。

## 2. 目录与 `package.json`

```
my-plugin/
├── package.json          { name, version, type: "module", piServer: { apiVersion: "1" } }
├── server/index.js       export default { init(host), dispose?() }
├── worker/index.js       export default { init({ bridge }) }
├── extension/index.js    export default { init(pi, { bridge }) }
├── web/*.js              export function mount(el, host)
└── types/plugin-types/   ← plugin check 写入，不要手改
```

`package.json` 只有两项归平台：

| 字段 | 语义 |
|---|---|
| `piServer.apiVersion` | 契约版本。**必须在 `package.json`** —— 装载器要**不执行你的代码**就判掉不兼容的包 |
| `piServer.requires.plugins` | 依赖的 **pi 原生插件**（包名 → semver）。只校验，不代勾 |

`piServer.facets` 这类声明式配置**已删除**：facet 由目录存在性表达，行为由代码默认导出表达。

## 3. 扩展点清单（写什么、在哪里）

```js
// server/index.js
export default {
  init(host) {
    host.ui.page({ path: '/my-plugin', label: '我的插件', icon: 'plug', component: 'page' });
    host.ui.slot({ slot: 'chat.rail.right', id: 'panel', title: '面板', component: 'panel' });
    host.ui.toolCard({ tool: 'my_tool', mode: 'replace', entry: 'card' });

    host.http.route({ method: 'GET', path: '/stats', handler: async () => ({ json: { ok: true } }) });
    host.http.route({ method: 'POST', path: '/hooks/*', handler: (req) => ({ json: { raw: req.path } }) });
    host.http.route({ method: 'GET', path: '/item/:id', handler: (req) => ({ json: { id: req.params.id } }) });

    host.methods.handle('sendFile', async ({ filePath }) => { /* ... */ });
    host.db.migrate('my_notes', 'CREATE TABLE IF NOT EXISTS my_notes (id TEXT PRIMARY KEY, body TEXT)');
  },
  dispose() { /* 可选：清定时器 / 长连接 */ },
};
```

## 4. 宿主能力面（`host`）

| 面 | 用途 | 要点 |
|---|---|---|
| `sessions` | `call` / `get` / `list` / `status` / `hasRow` / `subscribe` | `call` 是唯一调用口；`sessionId` 永远由你给（平台不提供"选会话"） |
| `agents` | `list` / `get` / `update` | 维护自己的配置块 |
| `db` | `migrate` / `query` | 读写都开放，走审计日志；只建自己的表 |
| `lifecycle` | `onSessionCreated` / `onSessionDisposed` | 返回退订函数 |
| `events` | `emit` | **仅 worker 侧**有效；server 侧调用会 warn |
| `ui` / `http` / `methods` | 注册面 | 都返回退订函数，卸载时平台也会统一撤 |

## 5. 硬约束（这些不是风格建议）

1. **顶层零副作用**：模块顶层只能 `import` 与导出对象。装载器在 `import()` 之后、`init()` 之前断言"注册增量为 0"，非零即**拒绝整个插件**（缓存失效会重复执行顶层，因此这条是硬的）
2. **注册只能发生在 `init()` 里**
3. **web 产物必须是原生 ESM**：不得含裸说明符（`import 'vue'` 浏览器解析不了）、不得 import node 内建、不得 `.ts`
4. **`mount(el, host)` 必须导出**并返回清理函数；DOM 只落在 `el` 内，不写全局 CSS
5. **不要在运行期 import 平台包**：`@pi-agent-platform/plugin-types` 是 types-only（用 `import type`）
6. **不要建平台表**（agents / sessions / attachments / plugin_migrations）

## 6. 自测（装完怎么看它对不对）

```bash
pi-server plugin check <dir>          # 入口 / ESM / 说明符 / web 产物 / 类型版本
pi-server plugin list                 # id / version / source / status / facets / dir
pi-server plugin reload              # 不重启 server 重装（server facet 立即生效）
```

- `GET /api/plugins/<id>/extensions` → 你注册了什么 **以及被拒了什么**（`rejected` 带原因）
- `GET /api/extensions` → 全局页面（已带 `label` / `path`，导航直接可用）
- `GET /api/p/<id>/...` → 你自己的端点
- 生效时机：**server facet 立即；worker / pi 扩展等下次 spawn；浏览器刷新**

## 7. 常见反模式

| 反模式 | 为什么错 | 正解 |
|---|---|---|
| 在模块顶层 `host.xxx.register()` | 装载器判"顶层有副作用" → 整包被拒 | 全部搬进 `init()` |
| 把 `host` 存到 `globalThis` 供下次用 | 下次 reload 顶层就会用它注册 → 被拒 | 每次都从 `init(host)` 拿 |
| 分别注册菜单和页面 | 菜单引用不存在会进 `rejected`；两处容易漂移 | `host.ui.page({ path, label, component })` 一次注册 |
| 在 web 产物里 `import { createApp } from 'vue'` | 浏览器无 import map → 挂载失败 | 自带运行时，或纯 DOM 写 |
| 用 `piServer.facets` 声明装载点 | 该字段已删除（第二套真相） | 放目录，让目录存在性说话 |
| 直接把平台包写进 `dependencies` | private 包，`npm i` 必失败 | 类型用 `plugin check` 写入的 `types/plugin-types/` |
| 插件读 registry 想自己判断启停 | registry 只是台账，bundled 插件根本不在里面 | 用 `/api/plugins` 或 `host` |
