# architecture（bundled 插件）

架构图：**顶栏图标 → 图列表面板 → 整页 iframe**。取代了原先长在 SPA 里的
`/architecture` 页面（`views/ArchitectureView.vue` + `constants/architecture-diagrams.ts` + `public/architecture/**`）。

## 为什么是插件

图是**数据**（每张 ~840K 的自包含 HTML），不是前端代码。放在插件里，加一张图只需换
`assets/` 里的文件并 reload 一次插件 —— 不必重新构建整个 SPA、也不必重新发前端。

## 目录

```
platform/plugins/architecture/
├── package.json                { piServer: { apiVersion: "1" } }
├── server/src/index.ts         清单（唯一事实源）+ 两条 HTTP 路由 + 两个装载点
├── web/src/panel.ts            顶栏面板：按集合分组的图列表（点一张 → 跳页）
├── web/src/viewer.ts           整页宿主：集合 × 图两级切换 + iframe + ?set=&d=
├── specs/**/*.json             archify 图源（手写，进 git）
└── assets/**/*.html            archify 产物（进 git，随包分发）
```

装载点：

| 注册 | 内容 |
|---|---|
| `host.ui.headerAction` | 顶栏「架构图」图标（`order: 20`，在主题切换之前，位置与旧硬编码图标一致） |
| `host.ui.page` | `/architecture`，`nav: false`（入口只在顶栏，不占导航项 —— 同 `notifications`） |
| `host.http.route` | `GET /manifest`（集合与图目录）、`GET /diagram/:file`（HTML 产物） |

产物走**插件自己的路由**而不是 `web/`：`/plugins/<id>/web/*` 只放行少数静态类型（`.html` 会被 415），
且 `web/` 的契约是「web facet 的编译产物」。插件路由可以直接返回标准 `Response`，平台原样透传。

## 加一张图

1. 写 `specs/<name>.<type>.json`（`type` ∈ architecture / sequence / workflow / dataflow /
   lifecycle / erd / tree / class / timeline / waterfall）
2. 生成产物（本机没有系统 Chrome，`ARCHIFY_CHROME` 指向 playwright 的 chromium）：

```bash
cd platform/plugins/architecture
ARCHIFY_CHROME=$HOME/.cache/ms-playwright/chromium-1194/chrome-linux/chrome \
  node ~/.pi/agent/skills/archify/bin/archify.mjs finalize <type> \
    specs/<name>.<type>.json assets/<name>.<type>.html \
    --repo-root /home/shinexsf/code/pi-agent-platform --quality showcase --json
```

3. 在 `server/src/index.ts` 的 `COLLECTIONS` 里加一行（**slug 全局唯一**，老链接只带 `?d=`）
4. `pnpm build:plugins architecture` → `pnpm build:web`（不需要，前端未变）→ `pi-server plugin reload architecture`

`finalize` 会顺带写出 `*.finalize.json` / `*.browser-check.json` 等证据文件 —— 它们是**一次性的校验回执**，
不用进 git（本目录的 `.gitignore` 已忽略）。

## 图源的约束（archify 会校验，不通过不产文件）

- `meta.repository` 要写**凭据无关的仓库地址 + 40 位 commit**；平台集合的图必须带
  `sources`（仓库相对路径 + 行号），且这些位置在该 commit 里真实存在
- `meta.output` 是相对工作目录的 POSIX 路径 —— 这里固定 `assets/<name>.<type>.html`
- 布局规则很严（子标签宽度、标签与连线间距、边界不能套住非成员…）；报错信息会直接给出
  `supportedFixes`，按提示改坐标即可

## pi 集合

`assets/pi/` 是**原生 pi**（`@earendil-works/pi-coding-agent`）的 4 张图，随第一批移植过来：
内容讲的是依赖的下游，不随本平台演进，所以没重新生成（`specs/pi/` 保留原图源）。
