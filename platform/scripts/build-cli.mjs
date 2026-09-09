#!/usr/bin/env node
/**
 * build-cli.mjs — aggregate server + worker + channels + SPA into
 * `packages/cli/dist/`, then run `pnpm pack` to produce the installable tarball.
 *
 * better-sqlite3 is NOT bundled into the tarball. It is declared as a
 * runtime dependency of `pi-server`, so `npm install -g` triggers its standard
 * `install` hook (prebuild-install || node-gyp rebuild). Users on systems
 * without VS Build Tools / prebuild network access will need to resolve that
 * themselves (e.g. install a precompiled binary manually).
 *
 * Steps:
 *   1. compile CLI itself                    (so dist/bin.js etc. exist)
 *   2. pnpm -r build                         (server + worker + channels + packages)
 *   3. copy channels/shared (plain-JS helper) to cli/dist/server/channels/shared
 *   4. SPA builds                            (build:ide / build:web)
 *   5. clear aggregated subdirs and copy server dist (preserve CLI's own dist/)
 *   6. copy SPA public to cli/dist/server/public
 *   7. copy worker dist to cli/dist/worker
 *   8. copy channels + manifest to cli/dist/server/channels
 *   9. scan channels package.json deps and merge into cli/package.json
 *  10. pnpm pack (produce tarball, runs inside cli dir)
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = path.resolve(__dirname, '..');        // <repo>/platform
const CLI_DIR = path.join(PLATFORM_DIR, 'packages', 'cli'); // <repo>/platform/packages/cli
const CLI_DIST = path.join(CLI_DIR, 'dist');
const SERVER_DIST = path.join(PLATFORM_DIR, 'apps', 'pi-agent-server', 'dist');
const SERVER_PUBLIC = path.join(PLATFORM_DIR, 'apps', 'pi-agent-server', 'public');
const WORKER_DIST = path.join(PLATFORM_DIR, 'workers', 'session-worker', 'dist');
const CHANNELS_DIR = path.join(PLATFORM_DIR, 'channels');
const MANIFEST = path.join(CHANNELS_DIR, 'manifest.json');

function log(msg) {
  process.stdout.write(`[build-cli] ${msg}\n`);
}

function run(cmd, args, opts = {}) {
  const wantedCwd = opts.cwd ?? PLATFORM_DIR;
  log(`$ ${cmd} ${args.join(' ')}  (cwd=${wantedCwd})`);
  // shell: true so Windows resolves `pnpm` / `pnpm.cmd` from PATH.
  // When we need a different cwd, prepend `cd /d <dir> && ` so pnpm runs there.
  const needsCwdPrefix = wantedCwd !== PLATFORM_DIR;
  const fullCmd = needsCwdPrefix
    ? `cd /d "${wantedCwd}" && ${cmd} ${args.join(' ')}`
    : `${cmd} ${args.join(' ')}`;
  const child = spawn(fullCmd, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true,
  });
  child.stdout.on('data', (b) => process.stdout.write(b));
  child.stderr.on('data', (b) => process.stderr.write(b));
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        process.stderr.write(`[build-cli] command failed: ${cmd} ${args.join(' ')} (exit ${code})\n`);
        reject(new Error(`exit ${code}`));
      } else {
        resolve();
      }
    });
  });
}

async function main() {
  log('step 1/10: clean CLI dist + compile CLI itself');
  // Clean CLI dist first to ensure fresh build (tsc incremental may skip unchanged files)
  if (existsSync(CLI_DIST)) {
    rmSync(CLI_DIST, { recursive: true, force: true });
  }
  await run('pnpm', ['--filter', 'pi-server', 'build']);

  log('step 2/10: pnpm -r build (compile server + worker + channels + packages)');
  await run('pnpm', ['-r', 'build']);

  log('step 3/10: copy channels/shared (plain-JS helper module imported by channels)');
  // channels/shared/ is plain .js (no TS, no workspace-internal imports) so it
  // doesn't need compiling — just copy the directory as-is.
  const sharedSrc = path.join(CHANNELS_DIR, 'shared');
  const sharedOutDir = path.join(CLI_DIST, 'server', 'channels', 'shared');
  rmSync(sharedOutDir, { recursive: true, force: true });
  if (existsSync(sharedSrc)) {
    mkdirSync(sharedOutDir, { recursive: true });
    cpSync(sharedSrc, sharedOutDir, { recursive: true });
    log(`  copied ${sharedSrc} → ${sharedOutDir}`);
  } else {
    log(`  skip (not found): ${sharedSrc}`);
  }

  log('step 4/10: SPA builds (build:ide / build:web — copy into server/public)');
  await run('pnpm', ['build:ide']);
  await run('pnpm', ['build:web']);

  log('step 5/10: clear aggregated subdirs and copy server dist');
  // Clear subdirs that will be re-created, but NOT CLI's own dist/ (step 1 compiled bin.js)
  for (const sub of ['server', 'worker', 'vendor', 'channels']) {
    const dir = path.join(CLI_DIST, sub);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  mkdirSync(path.join(CLI_DIST, 'server'), { recursive: true });

  if (!existsSync(SERVER_DIST)) {
    process.stderr.write(`[build-cli] server dist not found at ${SERVER_DIST} — did step 2 succeed?\n`);
    process.exit(1);
  }
  cpSync(SERVER_DIST, path.join(CLI_DIST, 'server'), {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      if (base === 'public') return false;       // copied separately in step 6
      if (base.startsWith('data.db')) return false; // dev DB never ships
      // Don't overwrite the channels/ subdir we already populated in step 3 / 8.
      // Compute the path relative to SERVER_DIST and check if it's a top-level dir.
      const rel = path.relative(SERVER_DIST, src);
      if (rel && !rel.startsWith('..') && rel.split(path.sep)[0] === 'channels') {
        return false;
      }
      return true;
    },
  });

  // Re-copy channels/shared after server dist (it was cleared in step 5)
  log('step 5b/10: re-copy channels/shared (cleared by step 5)');
  if (existsSync(sharedSrc)) {
    mkdirSync(sharedOutDir, { recursive: true });
    cpSync(sharedSrc, sharedOutDir, { recursive: true });
  }

  log('step 6/10: copy SPA public to cli/dist/server/public');
  mkdirSync(path.join(CLI_DIST, 'server', 'public'), { recursive: true });
  for (const spa of ['ide', 'web']) {
    const src = path.join(SERVER_PUBLIC, spa);
    const dst = path.join(CLI_DIST, 'server', 'public', spa);
    if (existsSync(src)) {
      cpSync(src, dst, { recursive: true });
      log(`  copied ${src} → ${dst}`);
    } else {
      log(`  skip (not found): ${src}`);
    }
  }

  log('step 7/10: copy worker dist to cli/dist/worker');
  if (!existsSync(WORKER_DIST)) {
    process.stderr.write(`[build-cli] worker dist not found at ${WORKER_DIST} — did step 2 succeed?\n`);
    process.exit(1);
  }
  cpSync(WORKER_DIST, path.join(CLI_DIST, 'worker'), { recursive: true });

  log('step 8/10: copy channels + manifest to cli/dist/server/channels');
  const channelsOut = path.join(CLI_DIST, 'server', 'channels');
  mkdirSync(channelsOut, { recursive: true });

  if (!existsSync(MANIFEST)) {
    process.stderr.write(`[build-cli] channel manifest not found at ${MANIFEST}\n`);
    process.exit(1);
  }
  cpSync(MANIFEST, path.join(channelsOut, 'manifest.json'));

  const manifestRaw = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const channelNames = Array.isArray(manifestRaw.channels) ? manifestRaw.channels : [];
  for (const name of channelNames) {
    const src = path.join(CHANNELS_DIR, name, 'dist');
    const dst = path.join(channelsOut, name, 'dist');
    if (existsSync(src)) {
      cpSync(src, dst, { recursive: true });
      log(`  copied ${src} → ${dst}`);
    } else {
      process.stderr.write(`[build-cli] channel dist not found: ${src}\n`);
      process.exit(1);
    }
  }
  // Note: channels/shared/ is copied separately in step 3 and already lives at
  // <CLI_DIST>/server/channels/shared/.

  log('step 9/10: scan channels package.json deps and merge into cli/package.json');
  const cliPkgPath = path.join(CLI_DIR, 'package.json');
  const cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf8'));
  const mergedDeps = { ...(cliPkg.dependencies ?? {}) };

  for (const name of channelNames) {
    const channelPkgPath = path.join(CHANNELS_DIR, name, 'package.json');
    if (!existsSync(channelPkgPath)) continue;
    const channelPkg = JSON.parse(readFileSync(channelPkgPath, 'utf8'));
    for (const [dep, ver] of Object.entries(channelPkg.dependencies ?? {})) {
      // Skip workspace-internal deps — they are bundled as source files, not npm deps.
      if (typeof ver === 'string' && ver.startsWith('workspace:')) continue;
      // If CLI already declares this dep, keep the CLI's version (don't downgrade).
      if (mergedDeps[dep]) continue;
      mergedDeps[dep] = ver;
    }
  }

  // Sort keys for stable diffs.
  const sortedDeps = Object.fromEntries(Object.entries(mergedDeps).sort(([a], [b]) => a.localeCompare(b)));
  cliPkg.dependencies = sortedDeps;
  writeFileSync(cliPkgPath, JSON.stringify(cliPkg, null, 2) + '\n', 'utf8');
  log(`  updated ${cliPkgPath} (${Object.keys(sortedDeps).length} deps)`);

  log('step 10/10: pnpm pack (produce tarball, runs inside cli dir)');
  // Run `pnpm pack` directly (no --filter) so the tarball is produced in CLI_DIR,
  // not in the workspace root.
  await run('pnpm', ['pack'], { cwd: CLI_DIR });

  const tarballName = `pi-server-${cliPkg.version}.tgz`;
  const expectedPath = path.join(CLI_DIR, tarballName);
  const strayPath = path.join(PLATFORM_DIR, tarballName);
  if (existsSync(strayPath) && strayPath !== expectedPath) {
    rmSync(strayPath);
    log(`  removed stray ${strayPath}`);
  }
  if (existsSync(expectedPath)) {
    log(`\n✔ built ${expectedPath}`);
  } else {
    process.stderr.write(`[build-cli] expected tarball not found at ${expectedPath}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(`[build-cli] fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});