#!/usr/bin/env node
/**
 * build-plugins.mjs —— 编译 **bundled** 插件的 web facet（design D15）。
 *
 * 为什么只有 bundled 走这里：`platform/plugins/*` 是我们自己写的插件，源码是 TS；
 * 第三方插件由作者自己编译，平台**不替别人编译**（否则 esbuild 会从 devDependency
 * 变成运行时依赖，还要处理别人的 tsconfig / alias / target）。
 *
 * 规则（四个 facet 一视同仁）：
 * - `plugins/<id>/<facet>/src/*.ts` → `plugins/<id>/<facet>/<name>.js`
 * - server / worker / extension：`platform: node`；web：`platform: browser`
 * - 一律 `bundle: false`：产物必须能直接 `import()`，且 web 产物不得含裸说明符
 * - 产物 gitignored；dev 用 `--watch`
 * - `--check`：只校验产物是否齐全（打包自检用，不写文件）
 *
 * 为什么不给 web 产物做 bundle：web facet 的产物必须是**浏览器可直接 import 的 ESM**，
 * 且不得含裸说明符（宿主没有 import map）。插件之间也不该共享 chunk —— 独立文件最简单。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = path.resolve(__dirname, '..');
const PLUGINS_DIR = path.join(PLATFORM_DIR, 'plugins');

const args = new Set(process.argv.slice(2));
const watch = args.has('--watch');
const checkOnly = args.has('--check');

/** 会编 TS 源码的 facet —— 与装载点一一对应。 */
const TS_FACETS = ['server', 'worker', 'extension', 'web'];

/** 列出 `<pluginsDir>/<id>/<facet>/src/*.ts`（四个 facet）。 */
function pluginSources() {
  if (!existsSync(PLUGINS_DIR)) return [];
  const out = [];
  for (const id of readdirSync(PLUGINS_DIR)) {
    for (const facet of TS_FACETS) {
      const srcDir = path.join(PLUGINS_DIR, id, facet, 'src');
      if (!existsSync(srcDir)) continue;
      for (const name of readdirSync(srcDir)) {
        if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
        out.push({
          id,
          facet,
          src: path.join(srcDir, name),
          out: path.join(PLUGINS_DIR, id, facet, `${name.replace(/\.ts$/, '.js')}`),
        });
      }
    }
  }
  return out;
}

/** 每个 facet 的编译目标：web 进浏览器，其余进 node。 */
function platformOf(facet) {
  return facet === 'web' ? 'browser' : 'node';
}

function log(msg) {
  process.stdout.write(`[build-plugins] ${msg}\n`);
}

const targets = pluginSources();
if (targets.length === 0) {
  log('no bundled plugin sources (plugins/*/{server,worker,extension,web}/src/*.ts) — nothing to do');
  process.exit(0);
}

if (checkOnly) {
  const missing = targets.filter((t) => !existsSync(t.out));
  if (missing.length > 0) {
    for (const t of missing) process.stderr.write(`[build-plugins] missing artifact: ${path.relative(PLATFORM_DIR, t.out)}\n`);
    process.exit(1);
  }
  log(`check ok — ${targets.length} artifact(s) present`);
  process.exit(0);
}

const esbuild = await import('esbuild');

// 每个源文件单独出包（`outfile`），所以公共选项里不能带 entryPoints/outdir。
// `platform` 由 facet 决定，见 `platformOf()`。
const baseOptions = {
  bundle: false,
  format: 'esm',
  target: 'es2022',
  sourcemap: false,
  logLevel: 'silent',
};

if (watch) {
  // watch 模式下逐文件建 context，输出路径与源文件同目录、同名 .js
  for (const t of targets) {
    const ctx = await esbuild.context({ ...baseOptions, platform: platformOf(t.facet), entryPoints: [t.src], outfile: t.out });
    await ctx.watch();
    log(`watching ${path.relative(PLATFORM_DIR, t.src)} → ${path.relative(PLATFORM_DIR, t.out)}`);
  }
  log('watch mode — Ctrl+C to stop');
} else {
  let failed = 0;
  for (const t of targets) {
    try {
      await esbuild.build({ ...baseOptions, platform: platformOf(t.facet), entryPoints: [t.src], outfile: t.out });
      log(`built ${path.relative(PLATFORM_DIR, t.out)}`);
    } catch (err) {
      failed += 1;
      process.stderr.write(`[build-plugins] failed ${path.relative(PLATFORM_DIR, t.src)}: ${err?.message ?? err}\n`);
    }
  }
  if (failed > 0) process.exit(1);
}

void statSync;
