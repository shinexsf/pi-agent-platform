#!/usr/bin/env node
/**
 * build-local-plugins.mjs —— 编**本机插件**（仓库根 `plugins/`）的 web facet 子项目。
 *
 * 为什么需要它：非 bundle 插件的 web facet 必须是"能直接 import() 的 ESM、无裸说明符"，
 * 而平台**刻意不替第三方插件编译**（否则 esbuild 会从 devDependency 变成运行时依赖，
 * 还要处理别人的 tsconfig / alias / target）。于是约定：
 *
 *   plugins/<id>/web-src/          ← 作者侧源码（可以 `import 'echarts'`、可以用 TS）
 *   ├── package.json               ← 必须有 "build" script（工具链随意：esbuild / vite / rollup）
 *   └── src/*.ts
 *   plugins/<id>/web/*.js          ← build 的产物（平台只认这个目录）
 *
 * 本脚本只做一件事：对每个有 `web-src/package.json` 的插件，在 `web-src/` 里跑 `npm run build`。
 * **它不替你做依赖安装**（`cd plugins/<id>/web-src && npm i` 一次），也不猜工具链 ——
 * 契约是"build 脚本把产物写进 ../web/"，其余自由。
 *
 * 用法（在 platform/ 下）：
 *   pnpm build:plugins:local          # 全部
 *   pnpm build:plugins:local channel-qq   # 指定一个
 *
 * 注意：仓库根 `plugins/` 是 gitignored 的本机桶，纯打包态实例用不到本脚本（它读的是本机插件）。
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = path.resolve(__dirname, '..');
const LOCAL_PLUGINS_DIR = path.resolve(PLATFORM_DIR, '..', 'plugins');

function log(msg) {
  process.stdout.write(`[build-local-plugins] ${msg}\n`);
}

const only = new Set(process.argv.slice(2).filter((a) => !a.startsWith('-')));

if (!existsSync(LOCAL_PLUGINS_DIR)) {
  log(`no local plugins dir (${LOCAL_PLUGINS_DIR}) — nothing to do`);
  process.exit(0);
}

/** 找出所有带 web-src 的插件（目录存在即可，package.json 缺失时跳过并提示）。 */
function targets() {
  const out = [];
  for (const id of readdirSync(LOCAL_PLUGINS_DIR)) {
    if (only.size > 0 && !only.has(id)) continue;
    const srcDir = path.join(LOCAL_PLUGINS_DIR, id, 'web-src');
    if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) continue;
    const pkgPath = path.join(srcDir, 'package.json');
    if (!existsSync(pkgPath)) {
      log(`skip ${id}: web-src/ 缺少 package.json（需要 "build" script）`);
      continue;
    }
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    } catch (err) {
      log(`skip ${id}: web-src/package.json 解析失败（${err.message}）`);
      continue;
    }
    if (typeof pkg.scripts?.build !== 'string') {
      log(`skip ${id}: web-src/package.json 没有 "build" script`);
      continue;
    }
    if (!existsSync(path.join(srcDir, 'node_modules'))) {
      log(`warn ${id}: web-src/node_modules 不存在 → 先 \`cd plugins/${id}/web-src && npm i\``);
    }
    out.push({ id, srcDir });
  }
  return out;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: 'inherit', shell: true, windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} → exit ${code}`))));
  });
}

const list = targets();
if (list.length === 0) {
  log('没有需要编译的 web-src（本机插件都没用到 npm 依赖，手写 ESM 才是默认形态）');
  process.exit(0);
}

let failed = 0;
for (const t of list) {
  log(`building ${t.id} …`);
  try {
    await run('npm', ['run', 'build'], { cwd: t.srcDir });
    const webDir = path.join(LOCAL_PLUGINS_DIR, t.id, 'web');
    const artifacts = existsSync(webDir) ? readdirSync(webDir).filter((n) => n.endsWith('.js')) : [];
    if (artifacts.length === 0) {
      log(`  !! ${t.id}: build 完成但 web/ 下没有 .js —— 检查 build 脚本的 outfile 是否指到 ../web/`);
      failed += 1;
    } else {
      log(`  ok ${t.id}: web/ 下 ${artifacts.length} 个产物（${artifacts.join(', ')}）`);
    }
  } catch (err) {
    failed += 1;
    log(`  failed ${t.id}: ${err.message}`);
  }
}

if (failed > 0) process.exit(1);
log('全部完成。产物已就位；重载插件（plugin reload）或刷新浏览器即可生效。');
