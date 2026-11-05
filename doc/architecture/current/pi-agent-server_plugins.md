# pi-agent-server 插件机制（`plugin-mechanism`）

> 一句话：**插件是「一个带 `package.json` 的目录 + 四种可选 facet」**，平台只负责装载、隔离、下发与转发；插件想加工具就写 pi extension，想加 UI 就写 web facet，平台不发明第二套工具 API。
>
> **给插件作者看的手册**：[插件使用手册](pi-agent-server_plugins-manual.md)（三十秒上手 / facet 签名 / 调试 / 坑）。本文只讲平台侧机制。
>
> 代码落点：`packages/plugin-types/`（契约）· `apps/pi-agent-server/src/services/plugins.ts`（registry）· `apps/pi-agent-server/src/routes/plugins.ts` / `plugin-assets.ts`（REST + 静态托管）· `workers/session-worker/src/plugins.ts`（worker/extension facet）· `apps/pi-agent-web/src/components/plugin/`（槽位宿主）· `packages/cli/src/plugin.ts`（安装命令）。

## 1. 设计边界（为什么长这样）

| 决定 | 理由 |
|---|---|
| **不碰 chord / pi-durable** | 跟着 coding-agent 生态走；durable 自己还是 `0.x` 且 "expect breaking changes"，引进来等于把内核押在实验 API 上 |
| **不发明对象/契约运行时** | 只借 chord 的**形态**（契约显式、数据跨宿主、UI 住在宿主），不借它的实现；wire 用平台自己的 JSON over HTTP/SSE/IPC |
| **pi 插件是依赖，不被包装** | 别人的 pi 扩展（能力/UI 类）继续原样用 pi 的 installer 装；平台插件只在 `requires.plugins` 里**校验**它们是否存在并在该 agent 的 `extensions` 白名单启用 |
| **`apiVersion` 从第一天就有** | 装了几十个插件之后再补版本协商是灾难；今天是常量 `'1'`，不匹配整包跳过并可见 |
| **不做热加载** | v1 = 启动时扫 + 安装时起会话；改了代码就 `pi-server restart`。热加载会让 worker 已经在跑的会话面临「半新半旧」 |

## 2. 目录与 manifest

安装目录形如 `~/.pi/server/plugins/<id>/`（`id` = npm 包名，`@scope/name` 会保留子目录）：

```
~/.pi/server/plugins/@probe/hud-demo/
├── package.json          ← 安装事实与兼容性闸门（`piServer.apiVersion`）
├── server/index.js       ← facet 1（可选）
├── worker/index.js       ← facet 2（可选）
├── extension/index.js    ← facet 3（可选）
└── web/panel.js          ← facet 4 的浏览器入口（`entry` 对应文件名）
```

```json
{
  "name": "@probe/hud-demo",
  "version": "0.0.1",
  "piServer": {
    "apiVersion": "1",
    "requires": { "plugins": { "@someone/pi-ext": "^2.0.0" } }
  },
  "peerDependencies": { "@someone/pi-ext": "^2.0.0" }
}
```

界面贡献**不在 `package.json` 里**：插件在 `server/index.js` 的 `register(host)` 里调用注册器（菜单、页面、端点、槽位、工具卡片），见 [`pi-agent-server_plugins-runtime.md`](./pi-agent-server_plugins-runtime.md)。`package.json` 只表达**安装事实与兼容性闸门**。

- `apiVersion` 缺失 → 视为不兼容，整包跳过（`status: 'degraded'`，`detail` 里写原因）
- `requires.plugins` 是**校验**语义：未安装 / 未在该 agent `extensions` 启用 → 不加载，**绝不代勾**
- 注册项 `id` 在同一（作用域, 类别）内唯一；重复注册后者被拒并进入 `rejected`

## 3. 四类 facet（按运行位置分，不是按功能分）

| facet | 跑在哪 | 入口签名 | 能做什么 | 不能做什么 |
|---|---|---|---|---|
| `server` | 主进程 | `export function init(host: PluginServerHost)` | 注册菜单/页面/HTTP 端点/UI 槽位/工具卡片 | 直接碰 worker / DB / 会话 |
| `worker` | session worker | `export function activate(ctx: { bridge: PluginWorkerBridge })` | 用 pi SDK 加工具/中间件、`bridge.emit` 上行 | 阻塞会话启动 |
| `extension` | worker（作为 pi extension 装载） | `export default async function ({ bridge }) => ({ name, factory })` | **主力形态**：注册工具 / 工具拦截 / 读文件 | 无 `bridge` 时（未启用 bridged 模式）拿不到 `emit` |
| `web` | 浏览器（SPA 内） | `export function mount(el, host): () => void` | 在自己的 `el` 里渲染任意框架、`host.data.subscribe`、`host.api.post` | 写全局 CSS / teleport 到 `el` 外 / flush 会话 |

```ts
// extension facet：加工具（和原生 pi 扩展代码完全一样）
export default async ({ bridge }) => ({
  name: 'hud-tools',
  factory: (pi) => ({
    tool: () => ({ name: 'hud_echo', /* ... */ }),
    handlers: { 'tool_call': async (e) => { bridge.emit('tool_call', { name: e.toolName }); } },
  }),
});
```

**bridged mode**：extension facet 默认拿不到 `bridge`（pi 的 extension factory 只有 `pi` 参数）。平台的做法是给 `additionalExtensionPaths` 注入同目录的 **inline 包装模块**（导出 `extensionFactory`，内部 `await import('<插件真入口>')` 再把 `bridge` 塞进去）。代价是调用栈多一层，收益是**零改动复用 pi 扩展写法**。

## 4. 装载流程（启动时快照，会话时下发）

```
~/.pi/server/plugins/registry.json        ← 安装事实（唯一事实源，pi 不参与）
        │ loadPlugins()
        ▼
  PluginSnapshot（内存缓存 + fs.watch 失效）
        │ resolveSessionPlugins({ snapshot, agentExtensions, installedPiExtensions })
        ▼
  ResolvedPlugin[]  { id, dir, enabled, reason, extensionPath?, workerPath? }
        │ 随 spawn 参数下发 + GET /api/sessions/:id/plugins 下发给浏览器
        ▼
  worker：enabled 才 import；关闭只记 reason，不执行任何 import
```

**两层语义（别混）**：

| 层 | 事实源 | 效果 |
|---|---|---|
| 全局开关 | `registry.json` 的 `enabled` / `facets.*` | 关掉 → 任何会话都不加载 |
| 会话闸门 | 该会话 agent 的 `extensions` 白名单 × 插件声明的 `requires.plugins` | 依赖未启用 → **仅该会话**不加载（`reason: 依赖未启用: xxx`） |

插件**本身**不需要出现在 agent 的 `extensions` 里：那层白名单只用于它依赖的 pi 插件。

`reason` 是诊断代码（`kill-switch` / `not-installed` / `api-version` / `requires-missing` / `requires-not-enabled` / `facet-disabled` / `依赖未启用: <ids>`），`GET /debug/sessions/:id` 的 `plugins[]` 每条 `issues[].reason` 原样带出——**闸门解释不能丢**。

**浏览器侧同样按会话取**：web 端不给全局插件列表渲染槽位，而是 `GET /api/sessions/:id/plugins`（只返回该会话 `enabled` 的）。否则会话 A 启用了依赖、会话 B 没启用，B 的页面也会冒出 A 的图标——必须服务端不下发，前端隐藏不算数。占位会话（库里还没有行）返回全局可用集合。

## 5. 通路：双向窄桥（不 flush 会话）

```
 web facet ──POST /api/sessions/:id/plugins/emit──▶ server ──call('pluginEmit')──▶ worker facet
    ▲                                                    │                            │
    └──────── SSE 事件名 `plugin`（载荷带 pluginId/name/data）◀── 'plugin_event' ◀──┘
```

- 事件名固定为 **`plugin`**，`pluginId` 在载荷里而不是事件名里 —— 因为 `EventSource` 监听不到任意事件名，浏览器侧要能用**一个**处理器收全部插件
- 硬上限：单条 > 64 KiB 截断 + 一次 warn；每会话每秒 > 100 条丢弃 + 一次 warn
- 日志只记 `pluginId` / `name` / 字节数，**不落原始载荷**
- `pluginEmit` 失败不影响会话；插件不存在时返回 404 并带 `reason`

## 6. 运行期注册（唯一入口）

界面与端点贡献**全部来自运行期注册**，没有声明式清单：

```js
// server/index.js —— 在 server 进程里执行
export function init(host) {
  host.global.menus.register({ id: 'demo', label: '演示页', page: 'about', order: 1050 });
  host.global.pages.register({ id: 'about', title: '演示页', entry: 'page' });   // → web/page.js
  host.global.routes.register({ method: 'GET', path: '/echo', handler: (c) => c.json({ ok: true }) });
  host.session.surfaces.register({ id: 'hud', slot: 'chat.rail.right', title: 'HUD', icon: 'layers', entry: 'panel' });
  host.session.toolCards.register({ tool: 'sendFileToUser', mode: 'replace', entry: 'card' });
}
```

| 能力 | 注册器 | 作用域 | 浏览器侧文件 |
|---|---|---|---|
| 菜单项 | `global.menus` | 全局 | 无（点击跳到插件页） |
| 页面 | `global.pages` | 全局 | `web/<entry>.js` 的 `mount` |
| HTTP 端点 | `global.routes` | 全局 | 无 |
| 会话页槽位 | `session.surfaces` | 会话级 | `web/<entry>.js` 的 `mount` |
| 工具卡片 | `session.toolCards` | 会话级 | `web/<entry>.js` 的 `mount` |

- 内置槽位：`chat.rail.right`（轨道按钮 **+ 抽屉面板**，一个槽位 = 一个完整入口）
- 托管路径：`GET /plugins/<id>/web/<file>`、`GET /plugin-page/<id>/<page>`、`GET /api/p/<id>/*`，**同源**提供
- 挂载协议：`mount(el, host)` 返回 `dispose`；关闭顺序 **停推数据 → dispose() → 移除 el**
- 六层查询：`/api/extensions`（全局）· `/api/sessions/:id/extensions`（会话）· `/api/plugins/:id/extensions`（单插件全集，含 `rejected`）· `/plugins/*`（资产）· `/plugin-page/*`（页面）· `/api/p/*`（端点）
- 主题：只保证白名单 CSS 变量存在于 `el` 祖先链上（`--bg` `--surface` `--fg` `--fg-dim` `--border` `--accent` `--ok` `--warn` `--err`）
- 失败态：加载/挂载失败 → 该槽位显示「插件加载失败 + 原因」，其余界面不受影响；注册失败进入 `rejected`/`registerError` 并在目录页可见

## 7. CLI 与 REST

```bash
pi-server plugin add <dir> [--enable]   # 校验 apiVersion / peerDependencies → 复制目录 → 写 registry
pi-server plugin list [--json]
pi-server plugin enable|disable <id>
pi-server plugin remove <id> [--purge]  # 默认只反注册，--purge 才删目录
```

| 端点 | 用途 |
|---|---|
| `GET /api/plugins` | 安装事实（status/version/detail/declared/registered）——**不含任何运行期注册项** |
| `GET /api/plugins/reload` | 手工失效内存快照（registry 文件也会被 `fs.watch` 自动失效） |
| `GET /api/plugins/:id/extensions` | 单插件的全部注册项 + `rejected` + `registerError` |
| `GET /api/extensions` | **全局**注册项聚合（菜单/页面/路由）——web 端菜单唯一入口 |
| `GET /api/sessions/:id/extensions` | **会话级**注册项（槽位/工具卡片，经闸门过滤） |
| `GET /api/sessions/:id/plugins` | 会话级解析结果（只含 `enabled` 的） |
| `POST /api/sessions/:id/plugins/emit` | 浏览器 → 插件（`{ pluginId, name, data }`） |
| `GET /plugins/<id>/web/<file>` | web facet 静态资产（同源托管，`id` 从 registry 的 `dir` 解析） |
| `GET /plugin-page/<id>/<page>` | 插件页面入口（SPA 路由，静态一条） |
| `ANY /api/p/<id>/*` | 插件 HTTP 端点（启动时注册的唯一分发器） |

## 8. 不变量（改动时别踩）

1. **不碰会话数据流**：插件只能读上下文、挂工具、发事件，**绝不能** flush 会话或改 `messages.jsonl` 形状
2. **不直连 worker**：浏览器永不知道 worker 存在；唯一入口是 REST + SSE
3. **不默认安装**：内置 IM 渠道是平台自带（先加载、插件机制遇 manifest 用 id **接管**）；第三方插件一律显式 `install`
4. **插件不拥有数据库表**：要持久化就自己按 `id` 前缀建；平台不提供插件 schema DSL
5. **不做全局 CSS / 全局事件总线**：样式与状态都收在 `el` 与 `host` 里
6. **槽位只按会话下发**：绕过 `GET /api/sessions/:id/plugins` 直接渲染全局插件列表，会让闸门形同虚设
7. **kill switch 常驻**：`PI_PLUGINS=off` 时 registry 仍可读、全部插件 `status: 'disabled'`，默认清单照常工作

## 9. apiVersion 变更史

| 版本 | 日期 | 变化 |
|---|---|---|
| `1` | 2026-10-29 | 初版：四类 facet、两个内置槽位、双向桥、CLI |
| `1` | 2026-11-05 | **web 槽位改为会话级下发**（依赖未启用的会话不下发）；新增真实例子 `@platform/session-projection`（读压缩块） |
| `1` | 2026-11-05 | **声明式清单移除，改为运行期注册**：`register(host)`/`init(host)` 在 server 进程执行，作用域在 API 形状里（`global.*` / `session.*`）；新增菜单/页面/HTTP 端点/工具卡片四类贡献；查询拆成六层。不升版（未对外发布） |

## 9.5 元数据视图（配置页「平台插件」）

装完插件在 UI 里看不见，是这个机制上线后最直接的抱怨。`GET /api/plugins` + `GET /api/plugins/:id` 支撑配置页把"装了什么、声明了什么、依赖装没装、为什么没生效"讲清楚。**只读**：启停/安装/卸载仍只走 `pi-server plugin`。

### 数据来源：三层文件 + 一层缓存

| 字段 | 来源 | 读取时机 |
|---|---|---|
| `id` / `version` / `enabled` / `facets.*` 开关 / `dir` / `installedAt` | `<pluginsDir>/registry.json` | `loadPlugins()` |
| `apiVersion` / `requires.plugins` / `description` / `author` / `homepage` | 插件自己的 `package.json` | `readManifest(dir)` |
| facet 目录是否存在（= 声明） | 磁盘 `readdir` | `listFacetDirs(dir)` |
| facet 入口文件是否存在 | `existsSync(<dir>/<facet>/index.js 或 <dir>/dist/<facet>/index.js)` | 请求时现读 |
| 依赖包是否安装 | `settings.json` 的 `packages` → `<agentDir>/npm/node_modules/<pkg>` | 详情请求时现读 |

内存里的 `PluginSnapshot` 只是前三类的**解析结果缓存**（1s TTL + `fs.watch(registry.json)` 失效），不是独立数据源。

### 扩展点是四态，不是一个布尔

| 维度 | 含义 | 字段 |
|---|---|---|
| **声明** | 磁盘上有没有这个 facet 目录 | `declaredFacets` |
| **开关** | registry 里有没有被关 | `switches` |
| **入口** | 入口文件在不在（含期望路径） | `entries[facet].exists` |
| **装载** | 平台是否真的会执行它 | `facetSupport[facet]` |

`server` facet 现已真正装载（`init(host)`，`facetSupport.server = 'loaded'`），注册项通过 `/api/extensions` 与 `/api/plugins/:id/extensions` 呈现。把未装载的 facet 画成"可用"会直接制造"配置对了却不生效"的错觉——这正是本视图要消灭的东西。

旧的 `facets`（开关 ∧ 声明 ∧ 入口）保留给既有消费方；新代码请读上面四个字段。

### `status` 的语义边界

`active` / `degraded` / `disabled` / `pending` / `orphan` 全部由上述三层静态推导，**不包含**"worker 里 facet import 抛错"这类运行期失败。运行期证据只在会话调试信息里（`/debug/sessions/:id` 的 `plugins[].reason`）。页面因此不能把 `active` 读成"运行正常"。

### 准入规则（后续扩展点必须遵守）

新增扩展点（新 facet / 新 host API / 新的可注册贡献类型）的变更必须同时交付：① 装载实现；② 目录页上的字段与文案；③ "未装载 / 未生效"时的显式标注。缺任一项不算完成。

## 10. 明确未做（v1 范围声明）

- 插件配置 schema 与配置页渲染（先 `package.json` + 环境变量）——运行时配置目前只有平台自己的 `registry.json`
- 插件注册项的运行期增删（注册是启动期一次性；改 `register()` 需重启 server）
- 全局菜单/页面的**会话级**变体（菜单恒为全局，带 `sessionId` 参数也无意义）
- 插件间 API（`uses` 目前只做依赖校验，不注入对方句柄）
- 插件 UI 注入到任意 View（只到会话页 `chat.rail.right`）与左侧轨道
- 插件端点无鉴权（与平台其它 REST 一致，单用户本地场景）
