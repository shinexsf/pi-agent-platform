/**
 * Server entry point.
 */

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import path from 'node:path';
import process from 'node:process';
import { config } from './config.js';
import { logger } from './logger.js';
import { initDb } from './db/init.js';
import { createAgentRepo } from './repos/agent.repo.js';
import { createSessionRepo } from './repos/session.repo.js';
import { workerPool } from './worker-pool.js';
import { createAgentsRouter } from './routes/agents.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createEventsRouter } from './routes/events.js';
import { createAttachmentsRouter } from './routes/attachments.js';
import { createConfigRouter } from './routes/config.js';
import { createServerLogsRouter } from './routes/server-logs.js';
import { AttachmentStore } from './services/attachment-store.js';
import { startTimeoutScanner } from './session-timeout-scanner.js';
import { startImGateway, type ImGatewayHandle } from './im-gateway/index.js';
import { printStartupBanner } from './startup-banner.js';
import { initModelRegistry, listAvailableModels } from './model-registry.js';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createSpaFallback } from './static-spa.js';

async function main() {
  printStartupBanner();

  // Initialize ModelRegistry (best-effort; failures don't block server start)
  try {
    await initModelRegistry();
    const models = await listAvailableModels();
    logger.info({ modelCount: models.length }, 'model registry initialized');
  } catch (err) {
    logger.warn({ err }, 'model registry init failed (GET /:id/context models will be empty)');
  }

  // Ensure attachments root exists. mkdir recursive + force = idempotent.
  // Per-session subdirectories are created lazily by attachment-store.
  await mkdir(config.attachmentsDir, { recursive: true });
  logger.info({ dir: config.attachmentsDir }, 'attachments root ready');

  // Ensure uploads/extensions directory exists for plugin uploads
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.env.HOMEPATH ?? '.';
  const sep = home.includes('\\') ? '\\' : '/';
  const uploadsExtensionsDir = `${home}${sep}.pi${sep}server${sep}uploads${sep}extensions`;
  await mkdir(uploadsExtensionsDir, { recursive: true });
  logger.info({ dir: uploadsExtensionsDir }, 'uploads extensions root ready');

  const { db, raw } = initDb(config.databasePath);
  const agentRepo = createAgentRepo(db);
  const sessionRepo = createSessionRepo(db);
  const attachmentStore = new AttachmentStore(db, config.attachmentsDir);

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
  app.route('/api/sessions', createEventsRouter(workerPool));
  app.route('/api/sessions', createAttachmentsRouter({ sessionRepo, workerPool, attachmentStore }));
  app.route('/api/config', createConfigRouter(config));
  // 系统日志查看（读活跃日志文件，路径由 logger.ts 的 serverLogFile 唯一决定）
  app.route('/api/server-logs', createServerLogsRouter());

  // Capability control plane — SINGLE entry for all server-management abilities
  // exposed to agents via the callServer tool (register → dispatch → authorize → audit).
  const { registerAllCapabilities, installControlPlane } = await import('./capabilities/index.js');
  registerAllCapabilities({
    agentRepo,
    sessionRepo,
    workerPool,
    serverOpts: { nodeEnv: config.nodeEnv, port: config.port, maxWorkers: config.maxWorkers },
  });
  installControlPlane({ agentRepo, sessionRepo, workerPool, registerReverseCallHandler: (m, h) => workerPool.registerReverseCallHandler(m, h) });

  // Read-only capability metadata for the WebUI agent editor (capabilities 授权
  // checkbox list). Registry is the single source of truth — the UI never
  // hardcodes method names. Production endpoint (read-only, no secrets),
  // distinct from /debug/capabilities (dev-only, adds policy + invoke).
  const { listCapabilities: listCaps, CAPABILITY_MODULES: CAP_MODULES } = await import('./capabilities/registry.js');
  app.get('/api/capabilities', (c) =>
    c.json({
      modules: CAP_MODULES.map((m) => ({
        module: m,
        capabilities: listCaps(m).map((d) => ({
          method: d.method,
          access: d.access,
          scoped: d.scoped,
          summary: d.summary,
        })),
      })),
    }),
  );

  // Debug routes (dev/test only) — dynamic import so production never loads
  // debug code (incl. /debug/db raw SQL). See doc: pi-agent-server_debug-testing.md.
  if (config.isDev) {
    const { createDebugRouter } = await import('./routes/debug.js');
    app.route('/debug', createDebugRouter(workerPool, sessionRepo, db));
    const { createCapabilityDebugRouter } = await import('./routes/capabilities-debug.js');
    app.route('/debug/capabilities', createCapabilityDebugRouter(agentRepo, sessionRepo, workerPool));
    logger.info('debug routes mounted at /debug (incl. /debug/capabilities)');
  } else {
    logger.info('debug routes disabled (production mode)');
  }

  // Start placeholder timeout scanner (active sessions are never auto-killed)
  const scanner = startTimeoutScanner(workerPool, config.placeholderTimeoutMs);

  // Start IM gateway BEFORE serve() so its router can be mounted while
  // Hono's matcher is still mutable.
  let imGatewayHandle: ImGatewayHandle | undefined;
  try {
    imGatewayHandle = await startImGateway({
      agentRepo,
      sessionRepo,
      workerPool,
      rawDb: raw,
      attachmentStore,
    });
    app.route('/api/im', imGatewayHandle.imRouter);
    logger.info({ channels: imGatewayHandle.loadedTypes }, 'im-gateway started');
  } catch (err) {
    logger.warn({ err }, 'im-gateway failed to start');
  }

  // Start HTTP server (after all routes mounted)
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port }, 'server listening');
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    scanner.stop();
    if (imGatewayHandle) await imGatewayHandle.shutdown();
    await workerPool.shutdown();
    raw.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Mark worker crashes in DB
  workerPool.on('crash', (sessionId) => {
    sessionRepo.archive(sessionId);
    logger.info({ sessionId }, 'session archived (worker crash)');
  });

  // session_info_changed → sync sessions.title (session-title-sync, design D2/D4).
  // Fires for ANY pi-side rename source: HTTP/IM /name, pi TUI, future plugins.
  workerPool.on('session_info_changed', (sessionId: string, rawName: unknown) => {
    const session = sessionRepo.get(sessionId);
    if (!session) {
      // No row yet (placeholder) — skip, never create a row (D4). Auto-naming
      // plugins can't hit this either: the row is INSERTed before the first prompt.
      logger.debug({ sessionId }, 'session_info_changed skipped (no DB row)');
      return;
    }
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    const title = name ? name : undefined; // empty → clear (既有清空语义)
    if ((session.title ?? undefined) === title) return; // idempotent
    sessionRepo.update(sessionId, { title });
    logger.debug({ sessionId, title }, 'session title synced from pi');
  });
}

main().catch((err) => {
  logger.error({ err }, 'server fatal');
  process.exit(1);
});

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
