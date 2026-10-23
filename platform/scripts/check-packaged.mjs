#!/usr/bin/env node
/**
 * 打包产物静态自检 —— 在 `pnpm pack:cli` 产出 tgz 之前跑，秒级、无副作用。
 *
 * 为什么需要：workspace 包在 dev 下走 pnpm symlink + tsx 直跑 TS，`tsc`（moduleResolution: bundler）
 * 会把裸包名 import 原样留在产物里。于是"dev 全绿 + typecheck 全绿 + 装完就报
 * ERR_MODULE_NOT_FOUND"是结构性必然，只有静态扫产物才能提前发现。
 *
 * 覆盖范围（不做隔离安装/启动，那属于部署测试）：
 *   A. 必需产物存在（bin / server / worker / channels / SPA / workspace 包）
 *   B. 动态装载契约：channels/manifest.json → 渠道目录 → 入口文件
 *   C. manifest 指向：cli 的 bin/main、workspace 包的 main/exports 目标文件必须存在
 *   D. 模块说明符：相对路径存在、node: 内建、@pi-agent-platform/* 必须在产物内、第三方必须已声明
 *   E. 空跑防护：扫描文件数/说明符总数低于阈值直接失败（防正则失效导致静默通过）
 *
 * 用法：node scripts/check-packaged.mjs [--dist <dir>] [--json]
 * 退出码：0 通过；1 有错误。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATFORM_DIR = path.resolve(__dirname, '..');
const CLI_DIR = path.join(PLATFORM_DIR, 'packages', 'cli');

// 与 build-cli.mjs 的 RUNTIME_PACKAGES 保持一致：这些包必须随 tarball 发布
const RUNTIME_PACKAGES = [
  'shared-types',
  'channel-types',
  'api-types',
  'ipc-protocol',
  'sdk-integration',
];

/** 扫描文件数下限 / 说明符数量下限 —— 低于任一值说明检查本身失效了 */
const MIN_JS_FILES = 40;
const MIN_SPECIFIERS = 150;

/**
 * 已知可选依赖说明符白名单：运行时在 try/catch 里探测、可以不存在。
 * 加条目必须写清原因。
 */
const OPTIONAL_SPECIFIERS = new Set([
  // 例：'tree-sitter'（未安装时退化为纯文本高亮）
]);

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const args = process.argv.slice(2);
const distRoot = path.resolve(
  readFlag(args, '--dist') ?? path.join(CLI_DIR, 'dist'),
);
const asJson = args.includes('--json');

const errors = [];
const warnings = [];

function readFlag(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

function fail(rule, detail) {
  errors.push({ rule, ...detail });
}

function warn(rule, detail) {
  warnings.push({ rule, ...detail });
}

function rel(p) {
  return path.relative(distRoot, p).split(path.sep).join('/');
}

function mustExist(rule, file, hint) {
  const abs = path.join(distRoot, file);
  if (!existsSync(abs)) fail(rule, { file: rel(abs), detail: hint ?? 'missing' });
  return existsSync(abs);
}

// ── A. 必需产物 ──────────────────────────────────────────────────────────────

function checkArtifacts() {
  const required = [
    ['bin/pi-server.js', 'CLI 启动包装（package.json bin）'],
    ['dist/bin.js', 'CLI 编译入口（package.json main）'],
    ['dist/server/index.js', 'server 入口'],
    ['dist/worker/index.js', 'worker 入口（否则 session 无法 spawn）'],
    ['dist/server/channels/manifest.json', '渠道清单'],
    ['dist/server/public/web/index.html', 'web SPA'],
    ['dist/server/public/ide/index.html', 'ide SPA'],
  ];
  // dist/ 自身在 distRoot 下时，上面的路径要相对 CLI_DIR 解析
  const base = distRoot.endsWith(`${path.sep}dist`) ? path.dirname(distRoot) : distRoot;
  for (const [file, hint] of required) {
    const abs = path.join(base, file);
    if (!existsSync(abs)) fail('A.artifact', { file, detail: `缺少${hint}` });
  }

  // SPA 只有 index.html 没有 assets 是典型事故（复制漏掉 assets / 构建静默失败）：
  // 页面能开但白屏，且只有真实访问才能发现。
  for (const spa of ['web', 'ide']) {
    const assetsDir = path.join(distRoot, 'server', 'public', spa, 'assets');
    let entries = [];
    try {
      entries = readdirSync(assetsDir);
    } catch {
      fail('A.artifact', { file: `server/public/${spa}/assets`, detail: 'SPA 资源目录缺失（白屏）' });
      continue;
    }
    if (!entries.some((name) => name.endsWith('.js'))) {
      fail('A.artifact', {
        file: `server/public/${spa}/assets`,
        detail: `没有 .js 资源（${entries.length} 个文件）——SPA 构建或复制不完整`,
      });
    }
  }
  for (const name of RUNTIME_PACKAGES) {
    const pkgDir = path.join(distRoot, 'node_modules', '@pi-agent-platform', name);
    if (!existsSync(path.join(pkgDir, 'package.json'))) {
      fail('A.artifact', {
        file: `dist/node_modules/@pi-agent-platform/${name}`,
        detail: 'workspace 包未打进产物（安装后会 ERR_MODULE_NOT_FOUND）',
      });
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    } catch (e) {
      fail('A.artifact', {
        file: `dist/node_modules/@pi-agent-platform/${name}/package.json`,
        detail: `无法解析：${e.message}`,
      });
      continue;
    }
    checkManifestTargets(`@pi-agent-platform/${name}`, pkgDir, manifest);
  }
}

// ── B. 动态装载契约：渠道清单 → 目录 → 入口 ──────────────────────────────────

function checkChannels() {
  const manifestPath = path.join(distRoot, 'server', 'channels', 'manifest.json');
  if (!existsSync(manifestPath)) return; // 已由 A 报出
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    fail('B.channel', { file: 'server/channels/manifest.json', detail: `JSON 解析失败：${e.message}` });
    return;
  }
  const listed = Array.isArray(manifest.channels) ? manifest.channels : [];
  if (listed.length === 0) {
    warn('B.channel', { file: 'server/channels/manifest.json', detail: '渠道清单为空' });
  }
  for (const name of listed) {
    const entry = path.join(distRoot, 'server', 'channels', name, 'dist', 'index.js');
    if (!existsSync(entry)) {
      fail('B.channel', {
        file: `server/channels/${name}/dist/index.js`,
        detail: `manifest 声明了 ${name}，但产物中没有它的入口（动态 import 会运行时失败）`,
      });
    }
  }
}

// ── C. manifest 指向的目标文件 ───────────────────────────────────────────────

/** exports 值可能是字符串、条件对象、数组 —— 逐个取出所有目标文件 */
function collectExportTargets(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectExportTargets(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) collectExportTargets(v, out);
  return out;
}

function checkManifestTargets(label, pkgDir, manifest) {
  const targets = new Set();
  for (const key of ['main', 'module']) {
    if (typeof manifest[key] === 'string') targets.add(manifest[key]);
  }
  if (manifest.bin) {
    if (typeof manifest.bin === 'string') targets.add(manifest.bin);
    else for (const v of Object.values(manifest.bin)) targets.add(v);
  }
  for (const t of collectExportTargets(manifest.exports)) targets.add(t);
  for (const t of targets) {
    if (!t.startsWith('.')) continue; // 非相对目标（如裸包名 re-export）不在本层判定
    const abs = path.resolve(pkgDir, t);
    if (!existsSync(abs)) {
      fail('C.manifest', {
        file: rel(path.join(pkgDir, 'package.json')),
        detail: `${label} 的 ${t} 指向不存在的文件`,
      });
    }
  }
}

function checkCliManifest() {
  const pkgPath = path.join(CLI_DIR, 'package.json');
  const manifest = JSON.parse(readFileSync(pkgPath, 'utf8'));
  checkManifestTargets('pi-server', CLI_DIR, manifest);
  return manifest;
}

// ── D. 模块说明符 ────────────────────────────────────────────────────────────

function walkJsFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // dist/node_modules 里只会出现我们自己打包的 workspace 包（第三方走 npm 安装，
      // 不在这里），所以照常递归扫描，不额外排除。
      walkJsFiles(abs, out);
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      out.push(abs);
    }
  }
  return out;
}

/** 去掉块注释与整行注释（tsc 产物的 import 都在行首，整行剥离足够且不误伤 URL 字符串） */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const SPEC_PATTERNS = [
  // import x from "s" / import "s" / export * from "s"
  /(?:^|[\s;}])(?:import|export)\s+(?:[^\n'"`]*?\bfrom\s*)?["']([^"']+)["']/g,
  // import("s") / require("s")
  /(?:\bimport|\brequire)\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function extractSpecifiers(src) {
  const code = stripComments(src);
  const found = [];
  for (const pattern of SPEC_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(code))) found.push(m[1]);
  }
  return found;
}

/** 'hono/cors' → 'hono'；'@scope/pkg/sub' → '@scope/pkg' */
function packageNameOf(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function checkSpecifiers(cliManifest) {
  const declared = new Set([
    ...Object.keys(cliManifest.dependencies ?? {}),
    ...Object.keys(cliManifest.optionalDependencies ?? {}),
  ]);
  // 从产物内解析：workspace 包只应在 distRoot 内被找到（
  // 若回落到 monorepo 的 workspace symlink，说明 tarball 里缺了它）
  const resolveFromDist = createRequire(path.join(distRoot, 'server', 'index.js'));

  const files = walkJsFiles(distRoot);
  let specCount = 0;

  for (const file of files) {
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const spec of extractSpecifiers(src)) {
      specCount += 1;
      if (BUILTINS.has(spec)) continue;

      if (spec.startsWith('.')) {
        if (!existsSync(path.resolve(path.dirname(file), spec))) {
          fail('D.relative', { file: rel(file), detail: `相对导入 ${spec} 指向不存在的文件` });
        }
        continue;
      }

      if (spec.startsWith('#')) {
        warn('D.specifier', { file: rel(file), detail: `package imports（${spec}）未校验，需人工确认` });
        continue;
      }

      if (spec.startsWith('@pi-agent-platform/')) {
        try {
          const resolved = resolveFromDist.resolve(spec);
          if (!resolved.startsWith(distRoot + path.sep)) {
            fail('D.workspace', {
              file: rel(file),
              detail: `${spec} 解析到了产物之外（${rel(resolved)}）——tarball 里缺这个包`,
            });
          }
        } catch {
          fail('D.workspace', {
            file: rel(file),
            detail: `${spec} 在产物内解析失败——tarball 里缺这个包`,
          });
        }
        continue;
      }

      const pkgName = packageNameOf(spec);
      if (!declared.has(pkgName) && !OPTIONAL_SPECIFIERS.has(spec)) {
        fail('D.undeclared', {
          file: rel(file),
          detail: `${spec}（包 ${pkgName}）未在 packages/cli/package.json 声明，安装后不会存在`,
        });
      }
    }
  }

  // ── E. 空跑防护 ──
  if (files.length < MIN_JS_FILES) {
    fail('E.sanity', {
      file: rel(distRoot),
      detail: `只扫到 ${files.length} 个 .js（阈值 ${MIN_JS_FILES}）——产物不完整或扫描路径错误`,
    });
  }
  if (specCount < MIN_SPECIFIERS) {
    fail('E.sanity', {
      file: rel(distRoot),
      detail: `只抽到 ${specCount} 个说明符（阈值 ${MIN_SPECIFIERS}）——说明符提取可能失效`,
    });
  }

  return { files: files.length, specifiers: specCount };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

function main() {
  if (!existsSync(path.join(distRoot, 'server'))) {
    console.error(`[check-packaged] 找不到 ${path.join(distRoot, 'server')} —— 先跑构建`);
    process.exit(1);
  }

  checkArtifacts();
  checkChannels();
  const cliManifest = checkCliManifest();
  const stats = checkSpecifiers(cliManifest);

  const summary = {
    distRoot: rel(distRoot) || '.',
    files: stats.files,
    specifiers: stats.specifiers,
    errors: errors.length,
    warnings: warnings.length,
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, errors, warnings }, null, 2));
  } else {
    for (const w of warnings) console.log(`  ! ${w.rule}  ${w.file ?? ''}  ${w.detail ?? ''}`);
    for (const e of errors) console.log(`  ✗ ${e.rule}  ${e.file ?? ''}  ${e.detail ?? ''}`);
    console.log(
      `[check-packaged] ${errors.length === 0 ? '通过' : '失败'} — ` +
        `${summary.files} 个 .js / ${summary.specifiers} 个说明符 / ${errors.length} 错误 / ${warnings.length} 警告`,
    );
  }

  process.exit(errors.length === 0 ? 0 : 1);
}

main();
