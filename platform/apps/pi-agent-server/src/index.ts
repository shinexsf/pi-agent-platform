/**
 * Server entry point.
 */

import { serve } from '@hono/node-server';
import { createServerApp } from './app.js';
import { createHostApi } from './host-api-impl.js';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import path from 'node:path';
import process from 'node:process';
import { config } from './config.js';
import { logger } from '@pi-agent-platform/core';
import { initDb } from '@pi-agent-platform/core/db';
import { runModuleMigrations } from './db/modules.js';
import { createAgentRepo } from '@pi-agent-platform/core';
import { createSessionRepo } from '@pi-agent-platform/core';
import { createTemplateRepo } from './repos/template.repo.js';
import { createNotificationRepo } from './repos/notification.repo.js';
import { createNotifier } from './services/notifier.js';
import { createNotificationsRouter } from './routes/notifications.js';
import { initCoreConfig, initSessionRegistry } from '@pi-agent-platform/core';
import { workerPool } from '@pi-agent-platform/core';
import { createAgentsRouter } from './routes/agents.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createEventsRouter } from './routes/events.js';
import { createAttachmentsRouter } from './routes/attachments.js';
import { createConfigRouter } from './routes/config.js';
import { createTemplatesRouter } from './routes/templates.js';
import { createPluginsRouter } from './routes/plugins.js';
import { createExtensionsRouter, createPluginDispatcherRouter } from './routes/plugin-runtime.js';
import { createSessionPluginsRouter } from './routes/session-plugins.js';
import { createPluginAssetsRouter } from './routes/plugin-assets.js';
import { startPluginRuntime } from '@pi-agent-platform/core';
import { createServerLogsRouter } from './routes/server-logs.js';
import { createRuntimeMethodsRouter } from './routes/runtime-methods.js';
import { AttachmentStore } from '@pi-agent-platform/core';
import { startTimeoutScanner } from '@pi-agent-platform/core';
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

  // 内核只声明"我需要知道哪些值"，读 env / 推路径是入口的事。
  initCoreConfig({
    maxWorkers: config.maxWorkers,
    agentDir: config.agentDir,
    attachmentsDir: config.attachmentsDir,
    pluginsDir: config.pluginsDir,
    bundledPluginsDir: config.bundledPluginsDir,
    serverBuiltinSkillsDir: config.serverBuiltinSkillsDir,
    mcpConfigPath: config.mcpConfigPath,
    workerStartupTimeoutMs: config.workerStartupTimeoutMs,
    workerStopTimeoutMs: config.workerStopTimeoutMs,
    isDev: config.isDev,
  });

  const { db, raw } = initDb(config.databasePath);
  // 平台功能模块自带的表：内核只建 Agent / Session / 附件，其余由模块迁移创建。
  const migratedModules = runModuleMigrations(raw);
  logger.info({ modules: migratedModules }, 'module tables migrated');
  const agentRepo = createAgentRepo(db);
  const sessionRepo = createSessionRepo(db);
  const templateRepo = createTemplateRepo(db);
  const notificationRepo = createNotificationRepo(db);
  const attachmentStore = new AttachmentStore(db, config.attachmentsDir);

  // Session service layer (core-session-refactor) — SOLE entry for spawn/revive.
  // Must init BEFORE any consumer (routes / im-gateway / capabilities) handles a request.
  initSessionRegistry({ sessionRepo, agentRepo, workerPool });

  // Platform notification writer (inbox only). Standalone: `postNotification`
  // and server-side failures are its only callers.
  const notifier = createNotifier({ notificationRepo });

  // 插件与内核之间唯一稳定缝（四个能力面）；形状在内核，实现在入口。
  const hostApi = createHostApi({ raw, sessionRepo, workerPool, agentRepo });
  logger.info({ faces: Object.keys(hostApi) }, 'host api ready');

  // 装配交给工厂（可被别的进程内嵌），启动器只负责 listen / 信号。
  const { app, dispose } = await createServerApp({
    config,
    db,
    raw,
    agentRepo,
    sessionRepo,
    templateRepo,
    notificationRepo,
    attachmentStore,
    notifier,
    workerPool,
    hostApi,
  });

  // Start HTTP server (after all routes mounted)
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    logger.info({ port: info.port }, 'server listening');
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await dispose();
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
