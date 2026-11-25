# pi-agent-server architecture-plugin

> **架构图是 bundled 插件 `platform/plugins/architecture/`**：顶栏图标 → 图列表面板 → 整页 iframe。
> 本文讲这套东西怎么运转、加图怎么加。图本身的内容是各 `*.json` spec 的事。

## 为什么从 SPA 搬进插件

原先它在 SPA 里：`views/ArchitectureView.vue`（301 行）+ `constants/architecture-diagrams.ts`（硬编码清单）
+ `public/architecture/**`（8 张 ~840K 的自包含 HTML，共 6.7 MB）。问题不是代码多，而是**归属错了**：

| 事实 | SPA 里的代价 |
|---|---|
| 图是**数据**，不是前端逻辑 | 换一张图要 `pnpm build:web` 重建整个前端 |
| 清单是**服务端事实** | 浏览器里再存一份，加图要改两个地方 |
| 图不依赖 Vue / 路由 / 组件库 | 却占了 SPA 的路由表与打包产物体积 |

搬进插件后：图换文件 + `plugin reload` 即可；清单只在 server facet 里有一份；SPA 里零残留。

## 目录

```
platform/plugins/architecture/
├── package.json                { piServer: { apiVersion: "1" } }（无 requires）
├── README.md                   加图流程（含 archify 命令与 ARCHIFY_CHROME）
├── server/src/index.ts         清单（唯一事实源）+ 两个 UI 注册点 + 两条 HTTP 路由
├── web/src/panel.ts            R11 顶栏面板：按集合分组的图列表
├── web/src/viewer.ts           R1 整页：集合 × 图两级切换 + iframe + ?set=&d=
├── specs/**/*.json             archify 图源（手写，进 git，唯一事实源）
└── assets/**/*.html            archify 产物（进 git，随包分发）
```

## 四个注册点

| 注册 | 内容 | 为什么这样 |
|---|---|---|
| `host.ui.headerAction` | `{ id: 'diagrams', icon: 'architecture', title: '架构图', component: 'panel', order: 20 }` | 复刻旧的顶栏硬编码图标位置（插件动作排在通知之后、主题切换之前） |
| `host.ui.page` | `{ path: '/architecture', label: '架构图', component: 'viewer', nav: false }` | **`nav: false`**：入口只在顶栏，不在导航里多一个同名项（同 `notifications` 的 `/notifications`） |
| `host.http.route` | `GET /manifest` → `{ collections }` | 浏览器侧不硬编码任何图名 |
| `host.http.route` | `GET /diagram/:file` → `Response(html)` | 产物托管，见下 |

### 为什么产物走插件路由，而不是 `web/`

`/plugins/<id>/web/*`（`routes/plugin-assets.ts`）有两条硬约束：只读 `web/` 目录，只放行少数静态类型
（`.js` / `.css` / `.json` / 图片 / 字体）—— **`.html` 会被 415 拒掉**。而且 `web/` 的契约是「web facet 的
编译产物」，架构图是**数据产物**。

插件自己的 HTTP 路由可以返回标准 `Response`，平台原样透传（`plugin-runtime.ts`），所以零平台改动就能托管
静态文件。安全性由**文件名白名单**保证：`ALLOWED_FILES` 来自清单，不是任意路径读。

## 前端行为

```
/architecture?set=<collectionId>&d=<slug>
```

- 只给 `d=` 的老链接可用：按 slug 反查集合（**slug 必须全局唯一**）
- 每个集合记住上次看的那张图（`localStorage`），切集合时还原
- 首屏把 URL 补齐（`history.replaceState`），刷新与分享都能复现当前这张
- 顶栏面板选图后 `host.ui.navigate(...)`；**平台在路由变化时会关掉顶栏面板**
  （`AppShell` 的路由 watcher → `closeHeaderPanel()`），否则浮层会盖在新页面上

iframe 用 `position: fixed; top: var(--app-header-h)` 撑满视口剩余高度 —— 平台给插件页的容器默认带
padding，而这里要的是整页画布；`--app-header-h` 是 `PLATFORM_THEME_VARS` 里的承诺变量。

## 两个集合

| 集合 | 内容 | 证据 |
|---|---|---|
| `platform` | 本平台 6 张：内核边界 / 插件运行期 / 动作四投影 / 消息链路 / IM 网关 / 会话状态机 | 每张都带 `sources`（仓库相对路径 + 行号），编译时校验在该 commit 里存在 |
| `pi` | 原生 pi 4 张：生命周期 / 事件流 / 扩展点 / 会话文件 | 讲的是依赖的下游，不随本平台演进，随第一批移植过来未重新生成 |

## 加图 / 改图

1. 写 `specs/<name>.<type>.json`（`type` ∈ architecture / sequence / workflow / dataflow / lifecycle /
   erd / tree / class / timeline / waterfall）
2. 生成产物 —— `finalize` 内含 validate + deliver + strict check + **真实浏览器视觉校验**：

```bash
cd platform/plugins/architecture
ARCHIFY_CHROME=$HOME/.cache/ms-playwright/chromium-1194/chrome-linux/chrome \
  node ~/.pi/agent/skills/archify/bin/archify.mjs finalize <type> \
    specs/<name>.<type>.json assets/<name>.<type>.html \
    --repo-root /home/shinexsf/code/pi-agent-platform --quality showcase --json
```

3. 在 `server/src/index.ts` 的 `COLLECTIONS` 里加一行（slug 全局唯一）
4. `pnpm build:plugins architecture` → `pi-server plugin reload architecture`（浏览器刷新）

约束（archify 校验，不过不产文件）：

- `meta.repository` 必须写凭据无关地址 + **40 位 commit**；`sources` 的行号要在该 commit 里真实存在
- `meta.output` 是相对工作目录的 POSIX 路径（这里固定 `assets/<name>.<type>.html`）
- 布局规则很严（子标签宽度、标签与连线间距、边界不能套住非成员…），报错会给出 `supportedFixes`

`finalize` 会写出 `*.finalize.json` / `*.browser-check.json` 等一次性回执，插件目录的 `.gitignore` 已忽略。

## 平台侧的清理（这次一起删掉的）

- `apps/pi-agent-web/src/views/ArchitectureView.vue`、`src/constants/architecture-diagrams.ts`
- `apps/pi-agent-web/public/architecture/**`（产物迁进插件 `assets/`）、`architecture/**`（图源迁进 `specs/`）
- `main.ts` 里的 `/architecture` 路由、`AppShell.vue` 两处硬编码入口、`nav-tree.ts` 的 icon 分支

所以现在 `/architecture` 这个路径**完全由插件提供**：插件停用 → 顶栏图标与页面一起消失，平台其余功能不受影响。
