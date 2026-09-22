#!/usr/bin/env node
/**
 * dev.mjs — dev-mode launcher for pi-agent-server (`pnpm dev`, runs under tsx).
 *
 * Pins the dev environment BEFORE loading the server entry:
 *   - NODE_ENV=development — enable debug routes / debug code loading
 *   - PORT=3000            — dev default; matches scripts/stop-server.mjs default
 *   - strips ALL packaged-mode env (PI_SERVER_CLI, WORKER_DIST_DIR, PI_DATA_DIR,
 *     PI_ATTACHMENTS_ROOT, PI_LOG_FILE, CHANNELS_DIR, PUBLIC_DIR) — agent/CI
 *     shells may carry them (pointing at the installed pi-server), which would
 *     silently swap in the packaged worker/channels/DB and disable debug routes.
 *
 * Rationale: ambient shell env must not change dev semantics. To use another
 * port in dev, edit here (keep in sync with platform/scripts/stop-server.mjs).
 */

process.env.NODE_ENV = 'development';
process.env.PORT = '3000';
delete process.env.PI_SERVER_CLI;
delete process.env.WORKER_DIST_DIR;
delete process.env.PI_DATA_DIR;
delete process.env.PI_ATTACHMENTS_ROOT;
delete process.env.PI_LOG_FILE;
delete process.env.CHANNELS_DIR;
delete process.env.PUBLIC_DIR;

await import('../src/index.ts');
