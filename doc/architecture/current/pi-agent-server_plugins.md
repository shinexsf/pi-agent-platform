# pi-agent-server 插件机制（`plugin-mechanism`）

> 一句话：**插件是「一个带 `package.json` 的目录 + 四种可选 facet」**，平台只负责装载、隔离、下发与转发；插件想加工具就写 pi extension，想加 UI 就写 web facet，平台不发明第二套工具 API。
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
├── package.json          package.json#pi.plugin 声明
├── server/index.js       ← facet 1（可选）
├── worker/index.js       ← facet 2（可选）
├── extension/index.js    ← facet 3（可选）
└── web/panel.js          ← facet 4 的浏览器入口（`mountKey` 对应文件名）
```

```json
{
  "name": "@probe/hud-demo",
  "version": "0.0.1",
  "pi": {
    "plugin": {
      "apiVersion": "1",
      "requires": { "plugins": { "@someone/pi-ext": "^2.0.0" } },
      "web": {
        "surfaces": [
          { "id": "hud-rail", "slot": "chat.rail-icon", "mountKey": "panel", "title": "HUD 示例", "order": 10 },
          { "id": "hud-drawer", "slot": "chat.drawer", "mountKey": "panel", "title": "HUD 示例" }
        ]
      }
    }
  },
  "peerDependencies": { "@someone/pi-ext": "^2.0.0" }
}
```

- `apiVersion` 缺失 → 视为不兼容，整包跳过（`status: 'degraded'`，`detail` 里写原因）
- `requires.plugins` 是**校验**语义：未安装 / 未在该 agent `extensions` 启用 → 不加载，**绝不代勾**
- `web.surfaces[].id` 全局唯一；重复注册后者被拒

## 3. 四类 facet（按运行位置分，不是按功能分）

| facet | 跑在哪 | 入口签名 | 能做什么 | 不能做什么 |
|---|---|---|---|---|
| `server` | 主进程 | `export function activate(host: PluginServerHost)` | 注册 UI 槽位、写日志、（后续）加 REST 命名空间 | 直接碰 worker / DB / 会话 |
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
        │ resolveSessionPlugins({ snapshot, agentPlugins })
        ▼
  ResolvedPlugin[]  { id, dir, enabled, reason, extensionPath?, workerPath? }
        │ 随 spawn 参数下发
        ▼
  worker：enabled 才 import；关闭只记 reason，不执行任何 import
```

`reason` 是诊断代码（`kill-switch` / `not-installed` / `api-version` / `requires-missing` / `requires-not-enabled` / `facet-disabled`），`GET /debug/sessions/:id` 的 `plugins[]` 每条 `issues[].reason` 原样带出——**闸门解释不能丢**。

`agent.plugins` 的形状与 `extensions` 同构：`{ id, enabled, facets?: { web?: false } }`。

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

## 6. web 槽位

- 静态声明在 `package.json#pi.plugin.web.surfaces`（v1 静态；运行期 `host.surfaces.register()` 是 server facet 的增量能力，暂未实现）
- 内置槽位：`chat.rail-icon`（会话页右上轨道按钮）、`chat.drawer`（右侧抽屉内容）
- 托管路径：`GET /plugins/<id>/web/<file>`，**在同源下**提供服务（插件自己 import 的第三方库也在 `node_modules` 里，由 CLI 安装时打平），路径穿越与 ext 白名单双向校验，`id` 从 registry 的 `dir` 解析而不是拼字符串
- 挂载协议：`mount(el, host)` 返回 `dispose`；关闭顺序 **停推数据 → dispose() → 移除 el**
- `host` facade（`@pi-agent-platform/plugin-types/web`）：
  `data.subscribe(fn)`（载荷是冻结的普通 JSON，不是响应式对象）· `api.post(path, body)`（自己前缀）· `theme.get()/subscribe()` · `sessionId` · `log()`
- 主题：只保证白名单 CSS 变量存在于 `el` 祖先链上（`--bg` `--surface` `--fg` `--fg-dim` `--border` `--accent` `--ok` `--warn` `--err`）
- 失败态：加载/挂载失败 → 该槽位显示「插件加载失败 + 原因」，其余界面不受影响

## 7. CLI 与 REST

```bash
pi-server plugin install ./pkg --enable      # 校验 apiVersion / peerDependencies → 复制 → 写 registry
pi-server plugin install @scope/name         # 走 npm pack（本地 npm install 受 Node 类型剥离限制时会失败）
pi-server plugin list [--json]
pi-server plugin enable|disable <id> [--facet=server,web]
pi-server plugin remove <id>
```

| 端点 | 用途 |
|---|---|
| `GET /api/plugins` | registry 快照（status/version/detail/declared/registered） |
| `POST /api/plugins/reload` | 手工失效内存快照（registry 文件也会被 `fs.watch` 自动失效） |
| `GET /plugins/<id>/web/<file>` | web facet 静态资产 |
| `POST /api/sessions/:id/plugins/emit` | 浏览器 → 插件（`{ pluginId, name, data }`） |

## 8. 不变量（改动时别踩）

1. **不碰会话数据流**：插件只能读上下文、挂工具、发事件，**绝不能** flush 会话或改 `messages.jsonl` 形状
2. **不直连 worker**：浏览器永不知道 worker 存在；唯一入口是 REST + SSE
3. **不默认安装**：内置 IM 渠道是平台自带（先加载、插件机制遇 manifest 用 id **接管**）；第三方插件一律显式 `install`
4. **插件不拥有数据库表**：要持久化就自己按 `id` 前缀建；平台不提供插件 schema DSL
5. **不做全局 CSS / 全局事件总线**：样式与状态都收在 `el` 与 `host` 里
6. **kill switch 常驻**：`PI_PLUGINS=off` 时 registry 仍可读、全部插件 `status: 'disabled'`，默认清单照常工作

## 9. apiVersion 变更史

| 版本 | 日期 | 变化 |
|---|---|---|
| `1` | 2026-10-29 | 初版：四类 facet、三个内置槽位、双向桥、CLI |

## 10. 明确未做（v1 范围声明）

- 运行期注册槽位（`host.surfaces.register()`）、插件间 API（`uses`）、插件 UI 注入到任意 View（只到会话页）
- 热加载 / 会话内升级 / 滚动升级（版本钉死 + 显式 `restart`）
- 插件配置 schema 与配置页渲染（先 `package.json` + 环境变量）
- 插件自带 worker 进程（facet 只能挂在平台 worker 里）
- 插件市场 / 签名 / 权限模型（本地目录安装，信任模型 = 用户自己 `install`）
- IDE 端（JCEF）的插槽：当前只有 web SPA 有 `SlotHost`
