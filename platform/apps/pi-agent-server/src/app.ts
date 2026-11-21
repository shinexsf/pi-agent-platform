/**
 * 入口应用的装配工厂。
 *
 * 为什么要有工厂：「装配」与「启动」分开之后，入口可以被**别的进程内嵌**
 * （桌面端想在内嵌 HTTP 时直接 mount，而不是 fork 一个子进程）。启动器
 * （`index.ts` 的 `main()`）只负责读配置、建依赖、listen、处理信号。
 *
 * 这个文件里**没有** `listen`、没有环境变量读取、没有进程信号处理。
 */

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import path from 'node:path';
import { logger } from '@pi-agent-platform/core';
import { createAgentsRouter } from './routes/agents.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createEventsRouter } from './routes/events.js';
import { createAttachmentsRouter } from './routes/attachments.js';
import { createConfigRouter } from './routes/config.js';
import { createTemplatesRouter } from './routes/templates.js';
import { createPluginsRouter } from './routes/plugins.js';
import { createExtensionsRouter, createPluginDispatcherRouter } from './routes/plugin-runtime.js';
import { pluginActionRegistry, recordPluginMigration } from './host-api-impl.js';
import { createSessionPluginsRouter } from './routes/session-plugins.js';
import { createPluginAssetsRouter } from './routes/plugin-assets.js';
import { startPluginRuntime } from '@pi-agent-platform/core';
import { createServerLogsRouter } from './routes/server-logs.js';
import { createActionsRouter, createInteropRouter, createRuntimeMethodsRouter } from './routes/runtime-methods.js';
import { startTimeoutScanner } from '@pi-agent-platform/core';
import { startImGateway, type ImGatewayHandle } from './im-gateway/index.js';
import { existsSync } from 'node:fs';
import { createSpaFallback } from './static-spa.js';
import { listAvailableModels } from './model-registry.js';
import type { config as ServerConfig } from './config.js';
import type { DB } from '@pi-agent-platform/core/db';
import type Database from 'better-sqlite3';
import type { AgentRepo, HostApi, SessionRepo, WorkerPool } from '@pi-agent-platform/core';
import type { AttachmentStore } from '@pi-agent-platform/core';
import type { TemplateRepo } from './repos/template.repo.js';

/** 工厂的运行期依赖（全部由组合根构造并传入）。 */
export interface ServerAppDeps {
  config: typeof ServerConfig;
  /** drizzle 句柄（仅 debug 路由的原始 SQL 端点用）。 */
  db: DB;
  /** better-sqlite3 原始句柄（渠道包跑自己的迁移用）。 */
  raw: Database.Database;
  agentRepo: AgentRepo;
  sessionRepo: SessionRepo;
  templateRepo: TemplateRepo;
  attachmentStore: AttachmentStore;
  workerPool: WorkerPool;
  /** 宿主能力面（入口实现）；插件经它访问内核 —— 四个面，不是死接口。 */
  hostApi: HostApi;
}

/** 工厂返回：可 mount 的应用 + 释放它启动的资源。 */
export interface ServerApp {
  app: Hono;
  /** 停掉工厂启动的东西（插件运行期 / 渠道网关 / 超时扫描），不关 worker pool。 */
  dispose(): Promise<void>;
}

export async function createServerApp(deps: ServerAppDeps): Promise<ServerApp> {
  const { config, db, raw, agentRepo, sessionRepo, templateRepo, attachmentStore, workerPool, hostApi } = deps;

  const app = new Hono();

  // Static dirs (mounted before API routes so /api/* still takes precedence by exact match).
  // /ide/  ——  JCEF 加载 Vue SPA（pi-agent-ide 构建产物）
  // /web/  ——  浏览器 SPA（pi-agent-web 构建产物，跟 pi-agent-idea MVP 不相关但预留）
  const publicBaseDir = resolvePublicDir();
  mountStaticDir(app, '/ide/', path.join(publicBaseDir, 'ide'), '/ide/');
  mountStaticDir(app, '/web/', path.join(publicBaseDir, 'web'), '/web/');

  // API routes
  app.get('/api/health', (c) => c.json({ status: 'ok', uptime: process.uptime() }));
  // Global model registry — used by the IDE "Add Agent" dialog to populate a
  // dropdown instead of letting users type `provider/modelId` by hand.
  app.get('/api/models', async (c) => c.json(await listAvailableModels()));
  app.route('/api/agents', createAgentsRouter(agentRepo, sessionRepo, workerPool, attachmentStore));
  app.route('/api/sessions', createSessionsRouter(agentRepo, sessionRepo, workerPool, attachmentStore));
  app.route('/api/sessions', createEventsRouter());
  app.route('/api/sessions', createAttachmentsRouter({ sessionRepo, workerPool, attachmentStore }));
  app.route('/api/config', createConfigRouter(config));
  app.route('/api/templates', createTemplatesRouter(templateRepo));
  // 插件只读视图（安装只能走 pi-server plugin；本路由无写端点）
  app.route('/api/plugins', createPluginsRouter({ pluginsDir: config.pluginsDir, agentDir: config.agentDir }));
  app.route('/api/sessions', createSessionPluginsRouter({ workerPool, agentRepo, sessionRepo }));
  // 通知收件箱已下沉为 bundled 插件 `notifications`（change: plugin-mechanism-v2 之后第一块）：
  // 表、端点（`/api/p/notifications/*`）、反向方法 `notifications.post` 都归它。
  // 入口侧不再认识"通知"这个概念 —— 插件被禁用时入口零影响。
  // 运行期扩展点（注册式）：全局菜单/页面 + 插件端点分发器
  app.route(
    '/api/extensions',
    createExtensionsRouter({
      pluginsDir: config.pluginsDir,
      // 等 startPluginRuntime 完成再 reload（首次装载是异步的）
      reload: async () => (await pluginRuntime).reload(),
    }),
  );
  app.route('/api/p', createPluginDispatcherRouter({ pluginsDir: config.pluginsDir }));

  // 插件 web 资源（change: plugin-mechanism 6.1）：按 registry 解析插件真实目录。
  app.route('/plugins', createPluginAssetsRouter({ pluginsDir: config.pluginsDir }));
  // 启动插件运行期：静态快照 + 执行 register()/init() + 监听 registry 变化
  // 运行期句柄（reload 走这条，不重启 server）
  const pluginRuntime = startPluginRuntime(config.pluginsDir, {
    host: hostApi,
    // 动作契约：登记表由组合根持有，投影由 buildHost() 完成。
    actions: pluginActionRegistry(),
    actionsHttpEnabled: () => config.actionHttpEnabled,
    // R3：插件注册的反向方法挂到 worker→master 分发表（内核不暴露 WorkerPool）。
    registerService: (source, kind, handlers) => workerPool.registerService(source, { kind }, handlers),
    // R4：迁移台账（卸载时提示"留下的表"）。
    recordMigration: (pluginId, name) => recordPluginMigration(raw, pluginId, name),
  });
  void pluginRuntime.catch((err) => logger.error({ err: String(err) }, 'plugin runtime start failed'));
  // 系统日志查看（读活跃日志文件，路径由 logger.ts 的 serverLogFile 唯一决定）
  app.route('/api/server-logs', createServerLogsRouter());
  // IPC 方法清单（注册表的可观测面；只读诊断）
  app.route('/api/runtime/methods', createRuntimeMethodsRouter(workerPool));
  // 动作目录（一份 handler 的暴露面：reverse / service / tool / http）
  app.route('/api/runtime/actions', createActionsRouter());
  // 插件间目录（topic + service）：广播与定向调用并排可见，但仍是两条派发
  app.route('/api/runtime/interop', createInteropRouter());

  // Debug routes (dev/test only) — dynamic import so production never loads
  // debug code (incl. /debug/db raw SQL). See doc: pi-agent-server_debug-testing.md.
  if (config.isDev) {
    const { createDebugRouter } = await import('./routes/debug.js');
    app.route('/debug', createDebugRouter(workerPool, sessionRepo, db, agentRepo));
    logger.info('debug routes mounted at /debug');
  } else {
    logger.info('debug routes disabled (production mode)');
  }


  // Start placeholder timeout scanner (active sessions are never auto-killed)
  const scanner = startTimeoutScanner(workerPool, config.placeholderTimeoutMs);

  // Start IM gateway BEFORE any serve() so its router can be mounted while
  // Hono's matcher is still mutable.
  let imGatewayHandle: ImGatewayHandle | undefined;
  try {
    imGatewayHandle = await startImGateway({ agentRepo, sessionRepo, workerPool, rawDb: raw, attachmentStore });
    app.route('/api/im', imGatewayHandle.imRouter);
    logger.info({ channels: imGatewayHandle.loadedTypes }, 'im-gateway started');
  } catch (err) {
    logger.warn({ err }, 'im-gateway failed to start');
  }

  return {
    app,
    async dispose() {
      scanner.stop();
      if (imGatewayHandle) await imGatewayHandle.shutdown();
      logger.info('server app disposed');
    },
  };
}

/**
 * Resolve the SPA public directory.
 * - Packaged mode (started by `pi-server` CLI): PUBLIC_DIR env injected by CLI (absolute path to dist/server/public).
 * - Dev mode: `./public` relative to cwd (original behavior).
 */
function resolvePublicDir(): string {
  if (process.env.PI_SERVER_CLI === '1' && process.env.PUBLIC_DIR) {
    return process.env.PUBLIC_DIR;
  }
  return path.resolve('./public');
}

/**
 * Mount a static directory under a route prefix. If the directory doesn't exist,
 * logs a warning and skips mounting (so server still starts — e.g. before `build:ide`).
 */
function mountStaticDir(app: Hono, prefix: string, absDir: string, logLabel: string): void {
  if (!existsSync(absDir)) {
    logger.warn({ dir: absDir, label: logLabel }, 'static dir not found (run pnpm build:web / build:ide first)');
    return;
  }
  // Strip the prefix from the path so serveStatic can find the file under absDir.
  // E.g. /ide/assets/index.js → /assets/index.js, joined with root → public/ide/assets/index.js
  const baseWithoutSlash = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  app.use(`${prefix}*`, serveStatic({
    root: absDir,
    rewriteRequestPath: (p) => p.startsWith(`${baseWithoutSlash}/`) ? p.slice(baseWithoutSlash.length) : p,
  }));
  // Both SPAs use history routes. Resolve their fallback entry from the same
  // static root so direct navigation also works in CLI-packaged mode.
  const indexHtmlPath = path.join(absDir, 'index.html');
  if (existsSync(indexHtmlPath)) {
    app.get(`${prefix}*`, createSpaFallback(indexHtmlPath));
  }
  logger.info({ prefix, dir: absDir }, 'static dir mounted');
}
