# 插件作者契约（v2）

> change: `plugin-mechanism-v2`。这份文档是**写给插件作者**的：目录怎么放、代码怎么写、产物长什么样、怎么自查。
> 运行期的内部设计（装载器、账本、热加载）见 [插件运行期](pi-agent-server_plugins-runtime.md)。

## 0. 三十秒上手

```bash
# 一个最小插件：只提供一个配置页
mkdir -p my-plugin/server && cd my-plugin
cat > package.json <<'EOF'
{ "name": "my-plugin", "version": "0.1.0", "type": "module", "piServer": { "apiVersion": "1" } }
EOF
cat > server/index.js <<'EOF'
export default {
  init(host) {
    host.ui.page({ path: '/my-plugin', label: '我的插件', icon: 'plug', component: 'page' });
  },
};
EOF
mkdir -p web && cat > web/page.js <<'EOF'
export function mount(el, host) {
  el.innerHTML = '<h2>Hello</h2><p>这个页面由插件提供。</p>';
  return () => { el.innerHTML = ''; };
}
EOF

pi-server plugin check .      # 机械校验（会顺手写入类型声明）
pi-server plugin add .        # 登记 + 触发装载
```

刷新浏览器：顶层导航多出「我的插件」，点进去就是 `web/page.js` 渲染的内容，URL 是 `/my-plugin`。

## 1. 目录与 `package.json`

```
my-plugin/
├── package.json          ← 只放两行元数据（见下）
├── server/               ← ① 装载点：目录存在即声明
│   └── index.js          export default { init(host), dispose?() }
├── worker/               ← ②
│   └── index.js          同上
├── extension/            ← ③
│   └── index.js          export default { init(pi, host) }
├── web/                  ← ④ 浏览器产物（原生 ESM）
│   ├── page.js           export function mount(el, host)
│   └── panel.js
├── skills/               ← 数据目录（不是 facet）：插件生效即注入，不占 agent 配置项
│   └── my-skill/SKILL.md  ← front matter 必须有 name / description
└── types/plugin-types/   ← `plugin check` 写入的 vendored 类型（不要手改、不要提交进 git）
```

`package.json` 只有两项是平台认的：

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "type": "module",
  "piServer": {
    "apiVersion": "1",
    "requires": { "plugins": { "some-pi-extension": "^1.0.0" } }
  }
}
```

| 字段 | 语义 |
|---|---|
| `piServer.apiVersion` | 平台契约版本。**必须写在 `package.json`**（装载器要**不执行你的代码**就判掉不兼容的包） |
| `piServer.requires.plugins` | 依赖的**pi 原生插件**（包名 → semver）。只做校验：未安装、或该 agent 没启用 → 你的插件不装载，平台**不会**替你勾选 |

`piServer.facets` 这类声明式配置**已删除**：facet 由目录存在性表达，行为由代码默认导出表达。两者之外不设第三套真相。

## 2. 装载点与默认导出

### 2.1 `server/index.js` —— 进程内注册（菜单 / 页面 / 端点 / 方法 / 迁移）

```js
export default {
  init(host) {
    // R1 页面：菜单与路由一次注册（菜单由路由推出，不要分别注册）
    host.ui.page({ path: '/im/channels', label: 'IM 渠道', icon: 'chat', component: 'channels', order: 10 });

    // 只登记路由、不占导航项（入口在别处，例如顶栏面板里的「查看全部」）
    host.ui.page({ path: '/im/all', label: 'IM', icon: 'chat', component: 'all', nav: false });

    // R9 局部挂载点：槽位名只能取平台已定义的（当前仅 chat.rail.right）
    host.ui.slot({ slot: 'chat.rail.right', id: 'my-panel', title: '我的面板', component: 'panel' });

    // R10 工具卡接管
    host.ui.toolCard({ tool: 'my_tool', mode: 'replace', entry: 'card' });

    // R11 顶栏动作：图标按钮 + 点开的面板；`badge.endpoint` 返回 { count } 就显示角标
    host.ui.headerAction({
      id: 'inbox',
      icon: 'bell',
      title: '通知',
      component: 'hdr',
      order: 10,
      badge: { endpoint: '/unread-count' },
    });

    // R2 HTTP 端点：挂在 /api/p/<插件 id>/ 下
    host.http.route({ method: 'GET', path: '/stats', handler: async (req) => ({ json: { ok: true } }) });
    host.http.route({ method: 'POST', path: '/webhooks/*', handler: (req) => ({ json: { raw: req.path } }) });
    host.http.route({ method: 'GET', path: '/item/:id', handler: (req) => ({ json: { id: req.params.id } }) });

    // R3 反向方法：worker → 你（完整名 plugin.<你的 id>.<name> 由宿主拼）
    host.methods.handle('sendFile', async ({ filePath }) => { /* ... */ });

    // R4 表迁移（幂等；平台记台账，卸载时提示"留下的表"）
    host.db.migrate('my_notes', 'CREATE TABLE IF NOT EXISTS my_notes (id TEXT PRIMARY KEY, body TEXT)');
  },

  // 可选：平台不等待、不重试、不校验结果。定时器 / 长连接自己清。
  dispose() { clearInterval(myTimer); },
};
```

### 2.2 `worker/index.js` —— 会话进程内（正向方法）

```js
export default {
  init({ bridge }) {
    // R5 正向方法：master 或浏览器可以通过 sessions.call(会话, 'plugin.<id>.scan', args) 调到你
    bridge.registerMethod?.('scan', async (params) => ({ scanned: params }));
    bridge.emit('ready', { at: Date.now() });          // 上行事件（无回执，可丢）
    bridge.call?.('plugin.notifications.post', [{...}]); // 调反向方法
  },
};
```

### 2.3 `extension/index.js` —— 以 pi 扩展身份（工具 / 命令 / 钩子）

```js
export default {
  async init(pi, { bridge }) {
    pi.registerTool({
      name: 'my_tool',
      label: 'My Tool',
      description: '...',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      execute: async (_id, { text }) => ({ content: [{ type: 'text', text }] }),
    });
    pi.registerCommand?.('my-cmd', { handler: async () => 'ok' });
    pi.on?.('session_start', () => {});
  },
};
```

### 2.4 顶栏动作（R11）

顶栏右侧是插件可扩展的图标区。注册一次 = 一个图标按钮 + 点开就地展开的面板（不跳页、不占导航项）：

```js
host.ui.headerAction({
  id: 'inbox', icon: 'bell', title: '通知', component: 'hdr', order: 10,
  badge: { endpoint: '/unread-count' },   // 宿主定期 GET，返回 { count } 显示角标
});
```

- **折叠由宿主决定**：桌面平铺；窄屏只留前几个，其余进「更多」菜单（插件不用管）
- **角标要一个只读端点**：注册发生在 server 侧，拿不到浏览器里的实时状态
- 面板里做站内跳转用 `host.ui.navigate('/some/path')`（SPA 路由，不整页刷新）
- 想要"既能在顶栏快速看、又有正式页面"：R11 + `ui.page({ ..., nav: false })` 配对

### 2.5 `web/*.js` —— 浏览器组件

```js
export function mount(el, host) {
  const title = document.createElement('h2');
  title.textContent = `plugin ${host.pluginId}`;
  el.append(title);

  const off = host.data.subscribe(({ name, data }) => { /* worker 上行事件 */ });
  host.api.get('/stats').then((v) => console.log(v));

  return () => { off(); el.replaceChildren(); };   // 必须返回清理函数
}
```

**硬约束**：

- 产物必须是**原生 ESM**，且**不含裸说明符**（浏览器没有 import map，`import 'vue'` 只会在挂载时失败）
- 不得 import node 内建；不得写全局 CSS 选择器、不得 teleport 到 `el` 之外
- 所有 DOM 落在 `el` 之内；边界两侧只交换普通 JSON / 回调 / DOM 节点
- 想用框架可以自带运行时，但**不要 bundle 一份宿主已有的框架副本**（两边不共享实例）

## 3. 宿主能力面（`host`）

| 面 | 能用在哪 | 方法 |
|---|---|---|
| `sessions` | 全部 | `call(会话, 方法, 参数?)` · `get` · `list` · `status` · `hasRow` · `subscribe(会话, fn)` · **`ensure({ agentId, sessionId?, title? })`** · **`systemEvent({ sessionId, kind, instruction, data? })`** |
| `agents` | 全部 | `list` · `get` · `update(id, patch)` |
| `db` | 全部 | `migrate(name, ddl)` · `query(sql, params?)`（读写都开放，走审计日志） |
| `lifecycle` | 全部 | `onSessionCreated(fn)` · `onSessionDisposed(fn)` |
| `bus` | 全部 | `publish(topic, payload?)` · `subscribe(topic, fn)` —— **插件之间**的进程内总线（无回执、同步、慢订阅者丢弃）。例：scheduler 发 `scheduler.run.failed`，通知插件订阅 |
| `events` | **仅 worker** | `emit(name, data)` —— 发给**浏览器**（SSE）；server 侧调用会 warn |
| `ui`（注册面） | 仅 server | `page`（`nav: false` 可只登记路由）· `slot` · `headerAction` · `toolCard` |
| `ui`（浏览器侧） | 浏览器 | `navigate(path)` · `toast` · `sheet` |
| `http` | 仅 server | `route({ method, path, handler })` |
| `methods` | server / worker | `handle(name, fn)` |

- 每个注册 / 订阅都返回**退订函数**（平台卸载时也会统一撤，但你自己的资源要自己清）
- `sessions.call` 是唯一调用口：`prompt` / `abort` 这类平台方法与插件正向方法形状相同；**`sessionId` 永远由你给**（平台不提供"选会话"）
- `sessions.ensure` 是"取一个可用会话"（新建 / 懒恢复 / 目标无效抛错），`sessions.systemEvent` 是"把一条非用户消息交给会话"（信封由**内核**拼，你不要自己拼 `<system-event>`）
- 除 `db.migrate` 建表之外，别碰平台表
- **工具与 skill 不需要"注册到某个 agent"**：插件对该会话生效，它们就自动注入；插件的 `server` / `web` facet 是全局的，不受 agent 开关影响

## 3.1 主题：只用平台承诺的 CSS 变量

插件 web 面的 `el` 祖先链上一定有平台 CSS 变量，暗色自动切换。**不要写死颜色，也不要猜变量名** —— 猜错时 `var(--x, #fff)` 不报错、静默走 fallback，表现就是"暗色下这一块永远白底"（`plugin check` 会报 `theme-var-unknown`）。

| 类别 | 变量 |
|---|---|
| 背景 / 表面 | `--bg` `--surface` `--surface-raised` `--surface-subtle` `--surface-hover` |
| 文字 | `--text` `--text-secondary` `--text-tertiary` |
| 描边 | `--border` `--border-subtle` `--border-strong` |
| 主色 | `--accent` `--accent-hover` `--accent-ink` `--accent-soft` |
| 语义 | `--success(-soft)` `--warning(-soft)` `--danger(-hover/-soft)` `--on-error` |
| 其它 | `--focus` `--shadow-soft` `--shadow-raised` `--radius-sm/md/lg` `--font-sans` `--font-mono` |

清单的权威来源：`packages/core/src/plugins/constants.ts` 的 `PLATFORM_THEME_VARS`（与 `apps/pi-agent-web/src/style.css` 同步）。`host.theme.get()/subscribe()` 只在"给画布/图表定色"这类拿不到 CSS 的场景用。

## 4. 类型：vendored 文件，不走 npm

```bash
pi-server plugin check .     # 写入 types/plugin-types/{index.d.ts,web.d.ts,tsconfig.hint.json}
```

作者的 `tsconfig.json`：

```json
{ "compilerOptions": { "paths": { "@pi-agent-platform/plugin-types": ["./types/plugin-types/index.d.ts"] } } }
```

写法：

```ts
import type { PluginDefinition } from '@pi-agent-platform/plugin-types';
export default { init(host) { /* ... */ } } satisfies PluginDefinition;
```

为什么不用 `peerDependencies`：`@pi-agent-platform/plugin-types` 是 private 包，不在 npm registry 上 —— `npm i` 必然失败。类型以**文件**交付，文件里带版本常量，`plugin check` 会与平台版本比对（防止你照着过期类型写）。

`plugin-types` 是 **types-only**：它没有任何运行期导出。产物里出现 `import '@pi-agent-platform/plugin-types'`（非 `import type`）会被 `plugin check` 拒绝。

## 5. 自查与调试

```bash
pi-server plugin check <dir>     # 入口存在 / ESM / 说明符 / web 产物 / 类型版本
pi-server plugin list            # id / version / source(bundled|user) / status / facets / dir
pi-server plugin reload          # 让运行中的 server 重装插件（不重启）
pi-server plugin disable <id>    # 停用（保留数据）
pi-server plugin remove <id>     # 卸载（bundled 写墓碑；用户插件删登记，--purge 才删目录）
```

REST：

| 端点 | 看什么 |
|---|---|
| `GET /api/plugins` | 所有插件的状态、facet 探测结果 |
| `GET /api/plugins/:id/extensions` | 你注册了什么，**以及被拒了什么**（`rejected` 带原因） |
| `GET /api/extensions` | 全局页面（已带导航字段） |
| `GET /api/sessions/:id/extensions` | 该会话的槽位 / 工具卡 |
| `GET /api/p/<id>/...` | 你自己的端点 |

生效时机：**server facet 立即**（`plugin reload` 或 registry 变化）；**worker / pi 扩展等下次 spawn**；**浏览器刷新**。

## 6. 打包与分发

- **第三方**：自己编译 web 产物（平台不替你编译），发布 `.js`
- **随包（bundled）**：仓库 `platform/plugins/<id>/web/src/*.ts`，`pnpm build:plugins` 编译成 `web/*.js`；`check-packaged` 会断言产物存在
- 安装：本地目录 → `pi-server plugin add <dir>`；**没有**网页安装入口

## 7. 已知坑

| 症状 | 原因 |
|---|---|
| 插件列表里没有、也没有报错 | 用户插件必须登记（`plugin add`）；bundled 靠目录存在，落在错误的 `PI_SERVER_BUNDLED_PLUGINS_DIR` 下就不会被扫到 |
| `degraded`：`apiVersion` 不匹配 | `package.json` 的 `piServer.apiVersion` 与平台不一致（版本号写对了才能被装载） |
| 注册项进了 `rejected` | 重名 / 未定义槽位 / `*` 位置不合法 / web 入口文件不存在 —— 原因字段写清了 |
| 改了代码没生效 | 插件**代码**变化不会被文件监听捕获，跑 `pi-server plugin reload`；worker/pi 扩展还要等下次 spawn |
| 页面白屏、导航有项 | web 产物 404：检查 `web/<component>.js` 是否真的存在（`plugin check` 会红） |
| 详情页白屏，报 `undefined … 'params'` | **平台不给 `mount()` 传路由参数**：签名只有 `(el, host)`。页面注册成 `/x/:id` 后，id 要自己从 `location.pathname` 取最后一段（`new` 之类特殊值自己约定）。typecheck 拦不住（模块导出边界是 `any`） |
| 顶层注册导致整个插件被拒 | `import()` 后平台断言"注册增量为 0"，注册只能发生在 `init()` 里 |
| 暗色下输入框/按钮还是白底 | 用了不存在的 CSS 变量名（fallback 生效）。改用「3.1 主题」表里的变量，`plugin check` 会告警 |
| 工具/skill 在该 agent 上不出现 | `agent.config.plugins` 里没有这个插件（逐 agent 开关）；`server`/`web` facet 不受它影响，所以页面还在、工具没了 |
| 声明了 `skills/` 但不生效 | 目录结构必须是 `skills/<name>/SKILL.md`，且 frontmatter 有 `name`/`description`；`plugin check` 会红 |

## 8. 完整参考

随包示例（`plugin add` 直接可用）：

- `apps/pi-agent-server/skills/builtin/pi-plugin-authoring/examples/hello-plugin` —— 最小集（server + web）
- `apps/pi-agent-server/skills/builtin/pi-plugin-authoring/examples/kitchen-sink` —— 四类 facet 全景

平台自带的 inline 插件（`callServer`）见 `workers/session-worker/src/inline-plugins.ts`：它演示了"声明 → 白名单过滤 → 注入"的完整形状，也是"实现方在平台代码里"时的写法。
