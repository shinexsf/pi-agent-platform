# pi-agent-server Packaging & Distribution

> 把 server + worker + IM channels + SPA 聚合成一个 npm 分发包（`pi-server`），通过 `npm install -g` 部署。
>
> 关联：OpenSpec change `cli-packaging`（私域），dev-journal（私域）

## 目标

- **单一 npm 包**：`pi-server`（npm 包名 = 命令名）
- **跨平台 1 tarball**：Windows + Linux + macOS 共用，靠 `npm install` 时自动拉对应平台 native binary
- **dev 态零侵入**：仍可 `pnpm dev:server` 跑，原有开发流不变
- **数据跟代码分离**：`~/.pi/server/` 装数据，升级只动 npm 全局包目录
- **零基础设施依赖**：不用 Docker、不上公开 npm registry、不用 PM2 / systemd

## 打包产物

`pi-server-X.Y.Z.tgz` (~3-20 MB) 内容：

```
package/
├── package.json              # name=pi-server, bin={pi-server: ./bin/pi-server.js}
├── README.md
├── bin/pi-server.js          # shebang 薄壳，import('../dist/bin.js')
└── dist/
    ├── server/               # 编译后 server（含 im-gateway / channels / public SPA）
    │   ├── index.js
    │   ├── public/{ide,web}/  # Vue 3 SPA 构建产物
    │   └── channels/         # IM 渠道包（manifest + channel-{wechat,qq}/dist/）
    └── worker/               # 编译后 worker
        └── index.js
```

**不含**：
- `node_modules/`（依赖由 npm install 时装）
- `*.tgz`（产物）
- `data.db*`（运行时数据）
- `logs/`（运行时日志）
- 参考项目源码 / 私人文档（不随仓库发布）

## 构建流水线

`pnpm pack:cli` 一条命令完成所有：

```bash
pnpm pack:cli
# = node scripts/build-cli.mjs
```

**9 步**：

1. 编译 CLI 自己（`tsc` 产出 `packages/cli/dist/{bin,daemon,paths,env,logger}.js`）
2. 编译 workspace（`pnpm -r build`：server + worker + channels + SPA）
3. 拷贝 `channels/shared/` 到 `cli/dist/server/channels/shared/`（plain JS，无 TS 编译）
4. SPA 构建（`pnpm build:ide` + `pnpm build:web`，copy 到 `server/public/`）
5. 清空 `worker/` + `vendor/`，copy `server/dist/` 到 `cli/dist/server/`
6. 拷贝 `server/public/{ide,web}/` 到 `cli/dist/server/public/`
7. 拷贝 `worker/dist/` 到 `cli/dist/worker/`
8. 拷贝 `channels/{manifest.json,<name>/dist/}` 到 `cli/dist/server/channels/`
9. 扫描 `channels/*/package.json` 的 `dependencies`，合并去重写入 `cli/package.json`

最后跑 `pnpm pack` 在 `packages/cli/` 下产 `pi-server-X.Y.Z.tgz`。

构建脚本：[`scripts/build-cli.mjs`](../../../scripts/build-cli.mjs)（~250 行 plain Node.js + ESM）

## 部署与启动

```bash
# 在能访问 GitHub 或预编译 binary 的机器上
npm install -g ./pi-server-0.0.1-alpha.tgz

# 之后任何位置都能用 pi-server 命令
pi-server start     # 后台启动，pidfile 写入 ~/.pi/server/run/server.pid
pi-server status    # 检查 running / health
pi-server logs -f   # tail 日志
pi-server stop      # 优雅停止
```

数据目录（Linux/macOS：`$HOME/.pi/server/`，Windows：`%USERPROFILE%\.pi\server\`）：

```
~/.pi/server/
├── data/data.db          ← SQLite
├── attachments/          ← 用户上传
├── logs/server.log       ← server stdout/stderr
└── run/server.pid        ← 守护进程 PID
```

升级 = 装新 tarball（`npm install -g ./pi-server-X.Y.Z.tgz`）+ `pi-server start`，**数据不动**。

## 双模式启动机制

`PI_SERVER_CLI=1` 环境变量是 **marker**：CLI spawn server 时注入它，server 检测到就走"打包态"路径解析。

CLI spawn server 时注入 6 个环境变量：

| 变量 | 值 | 用途 |
|---|---|---|
| `PI_SERVER_CLI` | `'1'` | **marker** — server 检测到走打包态路径 |
| `NODE_ENV` | `'production'` | 关 debug 路由、关 stack trace |
| `WORKER_DIST_DIR` | `<global>/dist/worker` | worker 入口绝对路径 |
| `PI_DATA_DIR` | `<dataRoot>/data` | sqlite 目录 |
| `PI_ATTACHMENTS_ROOT` | `<dataRoot>/attachments` | 上传目录 |
| `CHANNELS_DIR` | `<global>/dist/server/channels` | 渠道 manifest + 包路径 |
| `PUBLIC_DIR` | `<global>/dist/server/public` | SPA 路径 |

server 端 4 个文件的路径解析模式（统一）：

```typescript
function resolveX(): string {
  // 打包态：CLI 注入的绝对路径
  if (process.env.PI_SERVER_CLI === '1' && process.env.X_DIR) {
    return process.env.X_DIR;
  }
  // dev 态：原相对路径（保持不变）
  return <原 candidates 数组>;
}
```

涉及文件：
- `worker-pool.ts` 的 `resolveWorkerEntry()`
- `config.ts` 的 `databasePath` / `attachmentsDir`
- `im-gateway/channel-loader.ts` 的 `findManifest()` + `loadChannel()`
- `index.ts` 的 `resolvePublicDir()`

**为什么用 marker 而不是"看 cwd"**：
- cwd 在 detached 进程下不可靠（PID 1 启动时 cwd 可能被重置）
- marker 显式，比"猜你在不在打包态"安全

## 渠道打包策略

IM channels（wechat + qq）在 dev 态直接 `import('channels/<name>/src/index.ts')`（tsx 实时编译）。打包态必须改成 `import('<dist-server-channels>/<name>/dist/index.js')`。

**问题**：channel 源码 `import { logger } from '@pi-agent-platform/server/im-gateway/logger'` 引 workspace 内部包，打包后 npm 装不到。

**解决**：

1. **新建 `channels/shared/`（plain JS）**：
   - `logger.js` — pino logger 副本（~10 行）
   - `channel-registry.js` — channel registry 副本（用 globalThis 共享 state）
   - `*.d.ts` — 类型 stub

2. **channel 改 import**：
   ```ts
   // 改前
   import { logger } from '@pi-agent-platform/server/im-gateway/logger';
   import { registerChannel } from '@pi-agent-platform/server/im-gateway/channel-registry';
   // 改后
   import { logger } from '../../shared/logger.js';
   import { registerChannel } from '../../shared/channel-registry.js';
   ```

3. **globalThis 共享 state**：server 端 `channel-registry.ts` 和 channels 的 `shared/channel-registry.js` 都通过 `globalThis['__pi_agent_platform_channel_registry__']` 共享 Map——同一进程，写入同一个 Map

4. **构建脚本**：把 `channels/shared/` 整个目录拷贝到 `cli/dist/server/channels/shared/`（plain JS 无需编译）

5. **channel 业务依赖平铺到 CLI 顶层 deps**：构建脚本扫描 `channels/*/package.json` 的 `dependencies` 字段，合并去重写入 `cli/package.json`——避免重复安装

## 跨平台 native binding

`better-sqlite3` 是 native binding。打包策略：

- **tarball 不含 binary**：体积小、跨平台通用
- **不写 postinstall**：跨平台最容易挂
- **不写 `"os"` / `"cpu"` 字段**：否则 npm 拒绝异平台安装
- **依赖 npm 标准 install hook**：`prebuild-install || node-gyp rebuild`
  - `prebuild-install` 从 GitHub Releases 拉预编译 `.node` 文件
  - 失败 fallback 到本地 `node-gyp rebuild`（需要 VS Build Tools / gcc）

**失败场景的用户责任**：
- GitHub Releases 不通（防火墙/网络）→ 等或换镜像
- 没编译工具链 → 装 VS Build Tools（Windows）或 `build-essential`（Linux）
- 都走不通 → 手动下载 prebuilt binary 解压到 `<global>/node_modules/better-sqlite3/`

详细 workaround 见 [`packages/cli/README.md`](../../../packages/cli/README.md) 的 Troubleshooting 段。

## 进程守护

CLI `start` 命令：

1. 检查 `pidFile` 是否还活（`process.kill(pid, 0)` 探活）
2. 创建数据目录子目录（`~/.pi/server/{data,attachments,logs,run}/`）
3. `spawn(process.execPath, [serverEntry], { detached: true, stdio: ['ignore', logFd, logFd], env: {...}, windowsHide: true })`
4. `child.unref()` 让 server 独立于 CLI 进程
5. 写 `pidFile`

CLI `stop` 命令：

- 读 `pidFile`
- POSIX：`process.kill(pid, 'SIGTERM')`，等 5 秒，超时 `SIGKILL`
- Windows：`exec('taskkill /F /PID <pid>')`（Windows 无 SIGTERM）
- 删 `pidFile`

**关键点**：
- `windowsHide: true`（server spawn）— 防止 detached 进程弹 cmd 窗口
- **`windowsHide: true`（worker spawn）**— `worker-pool.ts:spawn()` 同样需要，否则 worker 创建会弹空窗口（dev 态因为 server 在 cmd 跑不弹，packaged 态 server 没控制台 → 默认弹新窗口）

## 默认端口与配置

- **默认端口 9006**：CLI 强制 `PORT='9006'` 不继承 shell PORT，避免跟用户其他进程冲突
- **`pi-server status`** 显示端口也写死 9006（与 daemon 一致；MVP 阶段不暴露 PORT 配置）
- **`WORKSPACE_ROOT`** 默认 `process.cwd()`（server 启动时 cwd）— 每个 session 在不同 IDE workspace 跑，由调用方提供
- **`PI_AGENT_DIR`** 默认 `~/.pi/agent`（pi SDK 状态）
- **`PI_AGENT_ATTACHMENTS_ROOT`** 默认 `~/.pi-server/attachments`（dev）或 `~/.pi/server/attachments`（packaged）

## 与 OpenSpec / dev-journal 的关系

- **OpenSpec change `cli-packaging`**（`openspec/changes/cli-packaging/`，gitignored）：本架构变更的 proposal / design / specs / tasks 文档，49/49 tasks done
- **dev-journal**（`doc/dev-journal/`，gitignored）：开发过程记录 + 踩坑实录
- **architecture changelog**（`doc/architecture/changelog/`，gitignored）：架构变更轨迹
- **本文档**：公开的"打包架构是什么"，不含决策过程

## 不在 MVP 范围

- `update` / `rollback` 命令（post-MVP，alpha 验证稳定后）
- `--port` flag（post-MVP）
- `pi-server config` 命令读写 `config.env`（post-MVP）
- 跨平台 CI（GitHub Actions Windows + Linux matrix，post-MVP）
- 公开到 npmjs.com（保持私有 + 本地 tarball）