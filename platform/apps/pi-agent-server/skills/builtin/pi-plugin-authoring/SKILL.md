---
name: pi-plugin-authoring
description: 给 pi-agent-platform 写插件时读这份。讲 v2 契约：目录约定、四个装载点 + 顶栏动作的默认导出写法、五个能力面（含 bus / sessions.ensure / systemEvent）、插件自带 skill、web 主题变量、vendored 类型、`plugin check` 自查、产物硬约束（原生 ESM、无裸说明符）、常见坑。
---

# 给平台写插件

> 本 skill 是**动手版**：契约以本文 + 随包示例 + `plugin check` 为准，示例代码可直接跑。

## 0. 先读能跑的示例

| 示例 | 覆盖 | 位置 |
|---|---|---|
| `hello-plugin` | 最小集：server facet + 一个页面 | 本 skill 同目录的 `examples/hello-plugin/` |
| `kitchen-sink` | 四个装载点全景（server/worker/extension/web），工具 / 命令 / 钩子 / 槽位 / 工具卡 / 反向方法 | `examples/kitchen-sink/` |

把示例复制到一个**你自己的目录**再改（插件 id 就是 `package.json` 的 `name`，别在示例目录里直接改）。

装进运行中的实例试：

```bash
pi-server plugin check <示例目录>     # 机械校验（顺手写类型）
pi-server plugin add <示例目录>       # 登记 + 装载
pi-server plugin reload               # 已装过、改了代码时用这个（不重启 server）
```

关于注册表与生效（踩过才知道的四条）：

- 插件装在数据根下的 `plugins/`，登记台账是同目录的 `registry.json`；bundled 插件**不登记**（按目录发现）
- 台账存的是**绝对路径** → `mv` 插件目录之后必须重新 `plugin add`，否则插件会变成 `degraded` / 消失
- `plugin remove` 只注销登记与目录，**不清插件建的表**（CLI 会列出留下的表，自己决定 DROP）
- 装完对 agent 生效还需要一步：把插件 id 加进该 agent 的 `config.plugins`（空数组 = 一个都不注入）

## 1. 先选形态：你要加的是哪种东西

| 想做的事 | 写在 | 用哪个扩展点 |
|---|---|---|
| 加个配置页 / 一级页面 | `server/index.js` + `web/page.js` | R1 `host.ui.page` |
| 在会话页右侧轨道塞个面板 | 同上 + `web/panel.js` | R9 `host.ui.slot` |
| 接管某个工具的卡片渲染 | `server/index.js` + `web/card.js` | R10 `host.ui.toolCard` |
| 顶栏加图标按钮 + 点开的面板（铃铛类） | `server/index.js` + `web/<component>.js` | R11 `host.ui.headerAction` |
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
├── skills/<name>/SKILL.md ← 可选：插件自带的 agent 技能（见 §5）
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
    // 入口在顶栏、但也需要一个正式页面时：nav:false 只登记路由，不占导航项
    // （否则铃铛 + 同名导航项 = 两个入口，用户会当成 bug）
    host.ui.page({ path: '/my-notifications', label: '通知', icon: 'bell', component: 'page', nav: false });
    host.ui.headerAction({
      id: 'bell', icon: 'bell', title: '通知', component: 'panel', order: 10,
      badge: { endpoint: '/unread' },   // 浏览器定期 GET /api/p/<id>/unread 取 { count }
    });
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

### 槽位与浮层（写面板前先知道这三件事）

- **会话作用域**：rail 槽位与工具卡片只在**插件对该会话生效**时才渲染（即插件 id 在该会话/agent 的
  `config.plugins` 里）。页面、顶栏动作是全局的，不受这一层影响 —— 所以"面板有时有有时没有"
  先查启用列表，别怀疑 CSS。
- **rail 按钮的图标**：宿主渲染的是 `title` 的**首字符**（`icon` 字段当前不生效），
  所以 `title` 取短词（"展示" → 按钮显示「展」）。想要真图标得平台侧改进，插件做不到。
- **抽屉是滚动容器**：`chat.rail.right` 的面板默认挂在宿主抽屉里，而抽屉是 `overflow-y:auto` ——
  在里面放 `position:absolute` 的浮层会被裁掉/跟着滚。要浮窗就自己 `position:fixed` 并
  `appendChild(document.body)`，卸载时移除。

## 4. 宿主能力面（`host`）

| 面 | 用途 | 要点 |
|---|---|---|
| `sessions` | `call` / `get` / `list` / `status` / `hasRow` / `subscribe` / `ensure` / `systemEvent` | `call` 是裸 worker 方法调用；`sessionId` 永远由你给（平台不提供"选会话"）。`ensure` = 无人值守跑一轮的唯一入口（新建或复用，陌生 id **抛错**而不是照建）；`systemEvent` 把 `<system-event>` 信封交给会话，**信封文本由内核构造**，你只给结构化字段 |
| `sessions`/`agents` 的**返回值是 Promise** | `get` / `list` / `status` / `hasRow` / `agents.list` / `agents.get` / `agents.update` / `call` 全部 async | 插件拿到的是**适配层**（为了将来跨进程），同步写不会报错，只会静默拿到 `undefined` —— 这是最常见的"插件返回空"原因 |
| `agents` | `list` / `get` / `update` | 维护自己的配置块 |
| `db` | `migrate` / `query` | 读写都开放，走审计日志；只建自己的表 |
| `lifecycle` | `onSessionCreated` / `onSessionDisposed` | 返回退订函数 |
| `bus` | `declare(topic, {declaredBy})` · `publish` · `publishAndWait` · `subscribe` · `topics()` | 插件间**广播**（0..n）：topic 必须先声明、前缀是本插件 id；`declaredBy:'publisher'` 只有你能发、谁都能订阅；**handler 返回值被丢弃**。别叫它 `events` —— `events` 是发给浏览器的出口 |
| `services` | `provide(name, fn)` · `call(name, payload)` · `list()` | 插件间**定向调用**：恰好一个提供者、返回业务数据、错误外抛、无 `sessionId`。要拿数据就用它，不要试图从 `bus` 里取 |
| `events` | `emit` | **仅 worker 侧**有效；server 侧调用会 warn |
| `ui` / `http` / `methods` | 注册面 | 都返回退订函数，卸载时平台也会统一撤 |

## 4.1 事件还是服务：一句话判据

**返回值是元信息 → `bus`；返回值是数据 → `services`。**

```js
// 事件：通知别人"发生了什么"，0..n 个订阅者，拿不到业务数据
host.bus.declare('my.run.failed', { declaredBy: 'publisher' });
const r = host.bus.publish('my.run.failed', { id, reason });
// r = { ok: true, delivered: 1 }；没人订阅 = { ok: true, delivered: 0 }（正常态）

// 服务：对外提供一个能力，恰好一个提供者，调用方拿返回值
host.services.provide('unread', () => 7);            // 全名 my-plugin.unread
const n = await host.services.call('notifications.unread', {});
```

三条容易踩的：

- **订阅不存在的 topic 不报错**（返回 `state:'pending'`，等对方装载后生效）—— 所以不要把"顺序"写进假设
- **`services.call` 到没提供的名字会抛错**（`unknown service`），必须自己 try/catch 决定降级
- **事件处理器里不要等待**：`publishAndWait` 等最慢的订阅者，重型工作请在订阅方自己起异步

## 5. 插件自带 skill（给 agent 的技能）

插件可以带 agent 技能：`skills/<name>/SKILL.md`，装载时被扫进 `skillPaths` 一并下发
（worker 的 `additionalSkillPaths`）—— **装好插件、agent 就有这个技能，不需要逐 agent 勾选**。
目录是**数据不是装载点**（没有 `index.js`），所以不参与"顶层零副作用"那套校验。

```markdown
---
name: my-skill            # 必填，与目录名一致
description: 一句话说清什么时候该读这份（模型按它决定要不要加载）
---

正文：什么时候用 / 不要用、参数怎么填、常见错误。
```

`plugin check` 会校验文件存在与 frontmatter 字段（`skill-no-frontmatter` / `skill-frontmatter-field` /
`skill-missing-file` / `skills-empty`）。注意 `skills/` 是**数据目录**，构建/打包时容易被忽略：
**漏了不会让插件 degraded，只会静默少一个技能**，分发前自己确认 `skills/<name>/SKILL.md` 在产物里。

写 skill 的两条经验（来自 marketplace 级的踩坑）：

- **不要贴平台消息的原文示例**（`<system-event>` 那类信封）：模型会照着伪造一条"用户要求"。
  说清语义即可。
- **工具用法要写"先查再建"**：模型最爱凭印象拼参数。

## 6. web 产物的两条硬规矩

1. **主题变量只能用平台清单里的**（`PLATFORM_THEME_VARS`：背景 / 文字 / 描边 / 主色 / 语义色 /
   圆角 / 字体 / 代码高亮）。写错变量名**不会报错**，只是渲染成透明或继承父级 —— 所以写完跑一次
   `plugin check`，它会以 `theme-var-unknown` 把清单外变量点出来，别靠肉眼。
2. **拿不到路由参数**：`mountPluginPage(el, host)` 只给 `(el, host)`，没有 router / params。
   需要 id（例如编辑页 `/my-plugin/:id`）就从 `window.location.pathname` 自己解析。

## 7. 硬约束（这些不是风格建议）

1. **顶层零副作用**：模块顶层只能 `import` 与导出对象。装载器在 `import()` 之后、`init()` 之前断言"注册增量为 0"，非零即**拒绝整个插件**（缓存失效会重复执行顶层，因此这条是硬的）
2. **注册只能发生在 `init()` 里**
3. **web 产物必须是原生 ESM**：不得含裸说明符（`import 'vue'` 浏览器解析不了）、不得 import node 内建、不得 `.ts`
4. **`mount(el, host)` 必须导出**并返回清理函数；DOM 只落在 `el` 内，不写全局 CSS
5. **不要在运行期 import 平台包**：`@pi-agent-platform/plugin-types` 是 types-only（用 `import type`）
6. **不要建平台表**（agents / sessions / attachments / plugin_migrations）
7. **不要留空的装载点目录**：`web/`、`server/` 等目录存在但没有任何产物 → 整个插件判 degraded
8. **图标别靠 emoji**：插件 web 侧拿不到平台的 `AppIcon`，emoji 在缺字体的环境（headless 容器）
   会渲染成豆腐块 —— 用 inline SVG 或纯文字

## 8. 自测（装完怎么看它对不对）

```bash
pi-server plugin check <dir>          # 入口 / ESM / 说明符 / web 产物 / 类型版本
                                      # + skills frontmatter + 主题变量名 + 平台包运行期 import
pi-server plugin list                 # id / version / source / status / facets / dir
pi-server plugin reload              # 不重启 server 重装（server facet 立即生效）
```

- `GET /api/plugins/<id>/extensions` → 你注册了什么 **以及被拒了什么**（`rejected` 带原因）
- `GET /api/extensions` → 全局页面（已带 `label` / `path`，导航直接可用）
- `GET /api/p/<id>/...` → 你自己的端点
- 生效时机：**server facet 立即；worker / pi 扩展等下次 spawn；浏览器刷新**

## 9. 常见反模式

| 反模式 | 为什么错 | 正解 |
|---|---|---|
| 在模块顶层 `host.xxx.register()` | 装载器判"顶层有副作用" → 整包被拒 | 全部搬进 `init()` |
| 把 `host` 存到 `globalThis` 供下次用 | 下次 reload 顶层就会用它注册 → 被拒 | 每次都从 `init(host)` 拿 |
| 分别注册菜单和页面 | 菜单引用不存在会进 `rejected`；两处容易漂移 | `host.ui.page({ path, label, component })` 一次注册 |
| 在 web 产物里 `import { createApp } from 'vue'` | 浏览器无 import map → 挂载失败 | 自带运行时，或纯 DOM 写 |
| 用 `piServer.facets` 声明装载点 | 该字段已删除（第二套真相） | 放目录，让目录存在性说话 |
| 直接把平台包写进 `dependencies` | private 包，`npm i` 必失败 | 类型用 `plugin check` 写入的 `types/plugin-types/` |
| 插件读 registry 想自己判断启停 | registry 只是台账，bundled 插件根本不在里面 | 用 `/api/plugins` 或 `host` |
| 把浮层（tooltip / 预览窗）画在槽位容器里 | 容器的祖先可能是 `overflow:auto` → 被裁成一条白边 | `position:fixed` + 挂到 `document.body`，卸载时移除 |
| 在 web 里自己写颜色（`#333`、`rgba(...)`） | 跟平台主题脱节，暗色下直接不可读 | 用 `PLATFORM_THEME_VARS` 里的变量 |
| 用 emoji 当按钮图标 | 容器/headless 环境缺字体 → 豆腐块 | inline SVG 或文字 |
