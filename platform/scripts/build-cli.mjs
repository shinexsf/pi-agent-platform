#!/usr/bin/env node
/**
 * build-cli.mjs — aggregate server + worker + bundled plugins + SPA into
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
 *   2. pnpm -r build                         (server + worker + plugins + packages)
 *   4. SPA builds                            (build:ide / build:web)
 *   5. clear aggregated subdirs and copy server dist (preserve CLI's own dist/)
 *   6. copy SPA public to cli/dist/server/public
 *   7. copy worker dist to cli/dist/worker
 *   8. (retired) channels/manifest — IM 已下沉为插件，随包只带 `plugins/im`，零渠道
 *   9. (retired) 渠道依赖扫描 —— 渠道不再随包
 *  10. pnpm pack (produce tarball, runs inside cli dir)
 */

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { RUNTIME_PACKAGES } from './pack-manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = path.resolve(__dirname, '..');        // <repo>/platform
const CLI_DIR = path.join(PLATFORM_DIR, 'packages', 'cli'); // <repo>/platform/packages/cli
const CLI_DIST = path.join(CLI_DIR, 'dist');
const SERVER_DIST = path.join(PLATFORM_DIR, 'apps', 'pi-agent-server', 'dist');
const SERVER_PUBLIC = path.join(PLATFORM_DIR, 'apps', 'pi-agent-server', 'public');
const WORKER_DIST = path.join(PLATFORM_DIR, 'workers', 'session-worker', 'dist');
/** bundled 插件：目录存在即生效，随包分发（不进 registry）。 */
const BUNDLED_PLUGINS_DIR = path.join(PLATFORM_DIR, 'plugins');

function log(msg) {
  process.stdout.write(`[build-cli] ${msg}\n`);
}

/**
 * Workspace runtime packages (`@pi-agent-platform/*`) are consumed as raw TS in
 * dev (tsx) and compiled by tsc with `moduleResolution: bundler`, so the emitted
 * server/worker/channel JS still contains bare `@pi-agent-platform/shared-types`
 * imports. A packaged install has no workspace `node_modules`, so those imports
 * MUST resolve from inside the tarball: ship each package's compiled output under
 * `dist/node_modules/@pi-agent-platform/<pkg>` with a rewritten manifest
 * (`./src/index.ts` → `./dist/index.js`).
 *
 * Why not bundle them with esbuild: server/worker/channel dists resolve several
 * paths from `import.meta.url` (channels dir, public dir, worker entry); inlining
 * would move those anchors. Shipping real modules keeps dev and packaged
 * resolution semantics identical.
 */
// 打包清单：与 check-packaged.mjs 共用同一声明（scripts/pack-manifest.mjs）

function remapExportPath(p) {
  return p.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, '.js');
}

function remapExportsValue(value) {
  if (typeof value === 'string') return remapExportPath(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value)
        // Drop `types` conditions: the tarball ships no .d.ts, so a `types`
        // condition would advertise a .js file as type declarations.
        .filter(([k]) => k !== 'types')
        .map(([k, v]) => [k, remapExportsValue(v)]),
    );
  }
  return value;
}

async function copyWorkspaceRuntimePackages() {
  const targetRoot = path.join(CLI_DIST, 'node_modules', '@pi-agent-platform');
  rmSync(targetRoot, { recursive: true, force: true });
  for (const dirName of RUNTIME_PACKAGES) {
    const pkgDir = path.join(PLATFORM_DIR, 'packages', dirName);
    const pkgJsonPath = path.join(pkgDir, 'package.json');
    const distDir = path.join(pkgDir, 'dist');
    if (!existsSync(pkgJsonPath)) {
      log(`  skip (no package.json): ${pkgDir}`);
      continue;
    }
    if (!existsSync(path.join(distDir, 'index.js'))) {
      process.stderr.write(
        `[build-cli] missing ${path.join(distDir, 'index.js')} — did 'pnpm -r build' compile the workspace packages?\n`,
      );
      process.exit(1);
    }
    const srcPkg = JSON.parse(await readFile(pkgJsonPath, 'utf8'));
    const outDir = path.join(targetRoot, srcPkg.name.replace(/^@pi-agent-platform\//, ''));
    mkdirSync(outDir, { recursive: true });
    cpSync(distDir, path.join(outDir, 'dist'), { recursive: true });

    // Dev resolution points at ./src/*.ts (tsx); the packaged copy must point at
    // compiled JS, so the manifest is rewritten rather than shipped verbatim.
    const manifest = {
      name: srcPkg.name,
      version: srcPkg.version,
      type: srcPkg.type ?? 'module',
      private: true,
    };
    if (srcPkg.main) manifest.main = remapExportPath(srcPkg.main);
    if (srcPkg.exports) manifest.exports = remapExportsValue(srcPkg.exports);
    writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    log(`  packaged ${srcPkg.name} → ${outDir}`);
  }
}

function run(cmd, args, opts = {}) {
  const wantedCwd = opts.cwd ?? PLATFORM_DIR;
  log(`$ ${cmd} ${args.join(' ')}  (cwd=${wantedCwd})`);
  // shell: true so Windows resolves `pnpm` / `pnpm.cmd` from PATH.
  // When we need a different cwd, prepend `cd /d <dir> && ` so pnpm runs there.
  // 跨平台：用 spawn 的 cwd 选项，别拼 `cd /d`（cmd.exe 专用语法，Linux 下会变成 cd /d）
  const child = spawn(cmd, args, {
    cwd: wantedCwd,
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

  log('step 2/10: pnpm -r build (compile server + worker + plugins + packages)');
  // 编译前先清掉 server / worker 的 dist：tsc 不会删除"源文件已删"的旧产物，
  // 不清就会把搬迁前留下的死文件一起打进 tarball（曾把 dist/server/worker-pool.js、
  // dist/server/capabilities/* 这类移动走的模块残留装进包里）。
  for (const stale of [SERVER_DIST, WORKER_DIST]) {
    if (existsSync(stale)) rmSync(stale, { recursive: true, force: true });
  }
  await run('pnpm', ['-r', 'build']);

  log('step 4/10: SPA builds (build:ide / build:web — copy into server/public)');
  await run('pnpm', ['build:ide']);
  await run('pnpm', ['build:web']);

  log('step 5/10: clear aggregated subdirs and copy server dist');
  // Clear subdirs that will be re-created, but NOT CLI's own dist/ (step 1 compiled bin.js)
  for (const sub of ['server', 'worker', 'vendor', 'node_modules']) {
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
      return true;
    },
  });

  log('step 5c/10: package workspace runtime packages into dist/node_modules');
  await copyWorkspaceRuntimePackages();

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

  log('step 8b/10: build bundled plugin web facets + copy plugins to cli/dist/server/plugins');
  // web facet 的 TS 源码要编译成浏览器可直接加载的 ESM（平台只替**随包**插件编译）。
  await run('node', [path.join(PLATFORM_DIR, 'scripts', 'build-plugins.mjs')], { cwd: PLATFORM_DIR });
  const pluginsOut = path.join(CLI_DIST, 'server', 'plugins');
  if (existsSync(BUNDLED_PLUGINS_DIR)) {
    cpSync(BUNDLED_PLUGINS_DIR, pluginsOut, {
      recursive: true,
      // 只带运行期需要的东西：web/src 是源（产物已在 web/*.js），node_modules 是开发残留。
      filter: (srcPath) => {
        const segments = srcPath.split(/[\\/]/);
        if (segments.includes('node_modules')) return false;
        if (segments.includes('src')) return false;
        return !/\.(ts|map)$/.test(srcPath);
      },
    });
    log(`  copied ${BUNDLED_PLUGINS_DIR} → ${pluginsOut}`);
  } else {
    log('  no bundled plugins directory — skipped');
  }

  log('step 8c/10: copy plugin-types .d.ts (vendored delivery for `plugin check`)');
  // `plugin-types` 是 types-only 包（不在 RUNTIME_PACKAGES 里），但 `plugin check` 要
  // 把类型写进插件目录，所以声明文件必须随 CLI 分发。
  const typesSrc = path.join(PLATFORM_DIR, 'packages', 'plugin-types', 'dist');
  const typesOut = path.join(CLI_DIST, 'server', 'plugin-types');
  if (existsSync(typesSrc)) {
    mkdirSync(typesOut, { recursive: true });
    for (const name of readdirSync(typesSrc)) {
      if (name.endsWith('.d.ts')) cpSync(path.join(typesSrc, name), path.join(typesOut, name));
    }
    log(`  copied .d.ts → ${typesOut}`);
  } else {
    process.stderr.write('[build-cli] plugin-types dist missing — run `pnpm --filter @pi-agent-platform/plugin-types build`\n');
    process.exit(1);
  }

  // 渠道不再随包 → 依赖清单不再需要扫描合并；`pnpm pack` 仍要读 cli/package.json 的版本号。
  const cliPkg = JSON.parse(readFileSync(path.join(CLI_DIR, 'package.json'), 'utf8'));

  log('step 9b/10: static packaged check（产物自洽性，失败则不产 tgz）');
  try {
    await run('node', [path.join(PLATFORM_DIR, 'scripts', 'check-packaged.mjs'), '--dist', CLI_DIST]);
  } catch {
    const stale = path.join(CLI_DIR, `pi-server-${cliPkg.version}.tgz`);
    if (existsSync(stale)) {
      process.stderr.write(
        `[build-cli] 产物自检未通过；上次留下的 ${stale} 未被更新，请勿使用\n`,
      );
    }
    process.exit(1);
  }

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