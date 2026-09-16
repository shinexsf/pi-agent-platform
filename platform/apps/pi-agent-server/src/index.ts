/**
 * Server entry point.
 */

// Silence noisy third-party SDK logs that bypass pino (e.g. qq-bot-sdk WebSocket
// heartbeat "[CLIENT] 心跳校验 { op: 1, d: 2 }" prints once per ~30s).
const originalConsoleLog = console.log;
console.log = (...args: unknown[]) => {
  const first = args[0];
  if (typeof first === 'string' && (first.includes('心跳校验') || first.includes('[CLIENT]'))) {
    return;
  }
  originalConsoleLog(...args);
};

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import path from 'node:path';
import process from 'node:process';
import { config } from './config.js';
import { initDb } from './db/init.js';
import { createAgentRepo } from './repos/agent.repo.js';
import { createSessionRepo } from './repos/session.repo.js';
import { workerPool } from './worker-pool.js';
import { createAgentsRouter } from './routes/agents.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createEventsRouter } from './routes/events.js';
import { createDebugRouter } from './routes/debug.js';
import { createAttachmentsRouter } from './routes/attachments.js';
import { createConfigRouter } from './routes/config.js';
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
    console.log(`[server] model registry initialized (${models.length} available models)`);
  } catch (err) {
    console.warn('[server] model registry init failed (GET /:id/context models will be empty):', err);
  }

  // Ensure attachments root exists. mkdir recursive + force = idempotent.
  // Per-session subdirectories are created lazily by attachment-store.
  await mkdir(config.attachmentsDir, { recursive: true });
  console.log(`[server] attachments root: ${config.attachmentsDir}`);

  // Ensure uploads/extensions directory exists for plugin uploads
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.env.HOMEPATH ?? '.';
  const sep = home.includes('\\') ? '\\' : '/';
  const uploadsExtensionsDir = `${home}${sep}.pi${sep}server${sep}uploads${sep}extensions`;
  await mkdir(uploadsExtensionsDir, { recursive: true });
  console.log(`[server] uploads extensions root: ${uploadsExtensionsDir}`);

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

  // Debug routes (only in dev/test)
  if (config.isDev) {
    app.route('/debug', createDebugRouter(workerPool, sessionRepo, db));
    console.log('[server] debug routes mounted at /debug');
  } else {
    console.log('[server] debug routes disabled (production mode)');
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
    console.log(`[server] im-gateway started (${imGatewayHandle.loadedCount} channels: ${imGatewayHandle.loadedTypes.join(', ')})`);
  } catch (err) {
    console.warn('[server] im-gateway failed to start:', err);
  }

  // Start HTTP server (after all routes mounted)
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[server] listening on http://localhost:${info.port}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[server] received ${signal}, shutting down...`);
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
    console.log(`[server] session ${sessionId} archived (worker crash)`);
  });
}

main().catch((err) => {
  console.error('[server] fatal:', err);
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
    console.log(`[server] ${logLabel} not found at ${absDir} (run \`pnpm build:ide\` first)`);
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
  console.log(`[server] ${logLabel} mounted from ${absDir}`);
}
