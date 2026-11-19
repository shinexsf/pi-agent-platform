#!/usr/bin/env node
/**
 * build-plugins.mjs —— 编译 **bundled** 插件的 web facet（design D15）。
 *
 * 为什么只有 bundled 走这里：`platform/plugins/*` 是我们自己写的插件，源码是 TS；
 * 第三方插件由作者自己编译，平台**不替别人编译**（否则 esbuild 会从 devDependency
 * 变成运行时依赖，还要处理别人的 tsconfig / alias / target）。
 *
 * 规则：
 * - `plugins/<id>/web/src/*.ts` → `plugins/<id>/web/<name>.js`（原生 ESM，无打包）
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

/** 列出 `<pluginsDir>/<id>/web/src/*.ts`。 */
function webSources() {
  if (!existsSync(PLUGINS_DIR)) return [];
  const out = [];
  for (const id of readdirSync(PLUGINS_DIR)) {
    const srcDir = path.join(PLUGINS_DIR, id, 'web', 'src');
    if (!existsSync(srcDir)) continue;
    for (const name of readdirSync(srcDir)) {
      if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue;
      out.push({ id, src: path.join(srcDir, name), out: path.join(PLUGINS_DIR, id, 'web', `${name.replace(/\.ts$/, '.js')}`) });
    }
  }
  return out;
}

function log(msg) {
  process.stdout.write(`[build-plugins] ${msg}\n`);
}

const targets = webSources();
if (targets.length === 0) {
  log('no bundled plugin web sources (plugins/*/web/src/*.ts) — nothing to do');
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
const options = {
  bundle: false,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  logLevel: 'silent',
};

if (watch) {
  // watch 模式下逐文件建 context，输出路径与源文件同目录、同名 .js
  for (const t of targets) {
    const ctx = await esbuild.context({ ...options, entryPoints: [t.src], outfile: t.out });
    await ctx.watch();
    log(`watching ${path.relative(PLATFORM_DIR, t.src)} → ${path.relative(PLATFORM_DIR, t.out)}`);
  }
  log('watch mode — Ctrl+C to stop');
} else {
  let failed = 0;
  for (const t of targets) {
    try {
      await esbuild.build({ ...options, entryPoints: [t.src], outfile: t.out });
      log(`built ${path.relative(PLATFORM_DIR, t.out)}`);
    } catch (err) {
      failed += 1;
      process.stderr.write(`[build-plugins] failed ${path.relative(PLATFORM_DIR, t.src)}: ${err?.message ?? err}\n`);
    }
  }
  if (failed > 0) process.exit(1);
}

void statSync;
