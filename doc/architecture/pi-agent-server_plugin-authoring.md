# 插件编写说明（bundled 数据插件 `plugin-authoring`）

> change: `plugin-actions-contract`（2026-11-21）。取代了已退役的「平台内置 skill 轴」。

## 它是什么

`platform/plugins/plugin-authoring/` 是**只有 `skills/`、没有任何 facet** 的 bundled 插件：

```
plugin-authoring/
├── package.json                 piServer.apiVersion
└── skills/pi-plugin-authoring/
    ├── SKILL.md                 怎么写插件（v2 契约）
    └── examples/{hello-plugin,kitchen-sink}/
```

启用它（`config.plugins` 里加 `plugin-authoring`）= 该会话获得 `pi-plugin-authoring` skill。
不启用 = 模型看不到这份说明（但平台照样能建 agent、开会话、聊完一轮）。

## 为什么是插件而不是"平台内置 skill"

原来的做法是一条**独立的轴**：`AgentConfig.serverBuiltinSkills` + 包内 `skills/builtin/<name>/SKILL.md`
+ `GET /api/config/server-builtin-skills` + worker 求交集喂 `additionalSkillPaths`。

`capabilities` 删掉后这条轴只剩**一个**候选值（`pi-plugin-authoring`）—— 为一份说明养一整条轴，
等于在一个"开关收敛成一个"的改动里再留第二个开关。所以：

- 随包 skill 与第三方插件 skill 走**同一条通路**（`skillPaths` 随 `config.plugins` 生效）
- `AgentConfig` 少两个字段（`serverBuiltinSkills` / `capabilities`），内核少一个 service 模块
- 打包少一条专用复制与断言（bundled 插件的 `skills/` 本来就随插件目录进 tgz）

## 顺带放开的一条判定：纯 skill 插件合法

原来"没有任何 facet"= `degraded`（`没有任何可加载的 facet`），`plugin check` 也报 `no-facet` 错。
现在**数据目录也算可加载内容**：

| 目录内容 | 状态 |
|---|---|
| 有任意 facet | `active` |
| 无 facet，但有 `skills/<name>/SKILL.md` | **`active`**（skill 随 `config.plugins` 注入）|
| 无 facet 也无 `skills/` | `degraded`（"没有任何可加载的 facet 或 skill"）|

判定点只有两处：`packages/core/src/plugins/registry.ts`（状态机）与 `plugins/check.ts`（`no-facet` 条件）。

## 为什么示例工程必须随包

`SKILL.md` 说"照这个改"，模型才有东西可读。示例是**可直接 `plugin add` 的完整插件目录**：

- `examples/hello-plugin` —— 最小集（server + web）
- `examples/kitchen-sink` —— 四类 facet 全景 + `bus.declare` + `services.provide` + `actions.define`
- `examples/channel-mock` —— **渠道插件**参考实现（`im.channel` namespace + `ImUplink`/`ChannelDriver` 形状 + 探针端点），
  对应 `im-as-plugin` 之后的"新渠道不进入本仓库"这条边界

`check-packaged.mjs` 断言 `dist/server/plugins/plugin-authoring/skills/**/SKILL.md` 与示例的 `package.json`
都在 tarball 里（目录在、文件不在时打包照样成功，只有装完才发现 `available_skills` 是空的）。

`SKILL.md` 里还有两节是新渠道 / 重型前端会用的：§4.3「插件之间怎么连（依赖倒置 + `plugin.loaded`）」与
§4.4「web facet 想要 npm 依赖怎么办（服务端做重活 / `web-src` 子项目自带构建 / 相对模块）」。

## 后续

它是**普通插件**：将来要加 server facet（例如提供 `plugin-authoring` 相关的动作）、加页面，
只需新增目录，不改任何判定，也不动平台代码。
