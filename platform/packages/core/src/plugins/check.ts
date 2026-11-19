/**
 * 插件机械校验（`pi-server plugin check` 与打包自检共用同一套规则）。
 *
 * 为什么需要它：插件是**产物**不是源码工程 —— 平台不替第三方编译（design D15），
 * 所以"这个目录能不能被装载"必须能在安装前回答，而不是等运行期 `import()` 失败。
 *
 * 只做**机械可判定**的检查（存在性 / 说明符 / 扩展名），不试图理解代码语义：
 * 语义问题（注册错槽位、handler 抛错）由装载器的 `rejected` 反馈，两处互补。
 *
 * 关于说明符扫描（design Open Question 1 的结论）：**不引 JS 解析器**。
 * 仓库里没有 `es-module-lexer`，为一个安装期提示引入解析器（外加其 ESL 兼容问题）
 * 不划算。这里用"先剥注释再正则"的做法，只认 4 种形态（静态 import/export、动态
 * import、require）。它对极端写法（拼接字符串、`eval`）会漏，但漏掉的写法本身就不该
 * 出现在插件产物里；宁可漏报也不误杀 —— 误杀会让作者怀疑平台而不是自己的产物。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { detectFacetEntry, listFacetDirs, readManifest } from './registry.js';
import { PLATFORM_THEME_VARS, PLUGIN_API_VERSION } from './constants.js';
import type { PluginFacetName } from '@pi-agent-platform/plugin-types';

export interface PluginCheckIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  file?: string;
}

export interface PluginCheckResult {
  ok: boolean;
  id: string;
  dir: string;
  facets: PluginFacetName[];
  issues: PluginCheckIssue[];
}

/** 运行期不允许出现的平台包（`plugin-types` 是 types-only，不是运行时依赖）。 */
const PLATFORM_RUNTIME_PACKAGES = ['@pi-agent-platform/plugin-types'];

/** web 产物里不允许的 Node 内建（浏览器没有）。 */
const NODE_BUILTINS = new Set([
  'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'child_process', 'process',
  'stream', 'url', 'util', 'zlib', 'worker_threads', 'node:fs', 'node:path',
]);

/** 剥掉行注释与块注释（保留字符串内容，避免把 `//` 里的 URL 当注释吃掉一半）。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
}

/** 抽出全部模块说明符（静态 / 动态 / require）。 */
export function extractSpecifiers(code: string): Array<{ spec: string; typeOnly: boolean }> {
  const src = stripComments(code);
  const out: Array<{ spec: string; typeOnly: boolean }> = [];
  const patterns: Array<{ re: RegExp; typeOnly: boolean }> = [
    // import type { X } from '...' / import { type X } from '...'
    { re: /import\s+type\s+[^'"]*?from\s*['"]([^'"]+)['"]/g, typeOnly: true },
    // import X from '...' / import { X } from '...' / import '...'
    // 负向先行断言排除 `import type`：否则同一条会被算成运行期导入（重复报错）。
    { re: /import\s+(?!type\s)(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g, typeOnly: false },
    // export ... from '...'
    { re: /export\s+(?:type\s+)?[^'"]*?\s+from\s*['"]([^'"]+)['"]/g, typeOnly: false },
    // import('...')
    { re: /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, typeOnly: false },
    // require('...')
    { re: /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g, typeOnly: false },
  ];
  for (const { re, typeOnly } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) out.push({ spec: m[1]!, typeOnly });
  }
  return out;
}

function listFiles(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p, ext));
    else if (name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** 校验一个插件目录（不执行任何插件代码）。 */
export function checkPluginDir(dir: string): PluginCheckResult {
  const absDir = path.resolve(dir);
  const issues: PluginCheckIssue[] = [];
  const push = (level: 'error' | 'warning', code: string, message: string, file?: string): void => {
    issues.push({ level, code, message, ...(file ? { file } : {}) });
  };

  const manifest = readManifest(absDir);
  const id = manifest?.name ?? path.basename(absDir);
  const facets = listFacetDirs(absDir);

  if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
    push('error', 'dir-missing', `目录不存在：${absDir}`);
    return { ok: false, id, dir: absDir, facets, issues };
  }
  if (!manifest) {
    push('error', 'no-manifest', 'package.json 缺失或缺少 piServer.apiVersion');
  } else if (manifest.apiVersion !== PLUGIN_API_VERSION) {
    push(
      'error',
      'api-version',
      `契约版本不匹配：插件声明 ${manifest.apiVersion}，平台要求 ${PLUGIN_API_VERSION}`,
    );
  }
  if (facets.length === 0) {
    push('error', 'no-facet', '没有声明任何装载点（server/ worker/ extension/ web/ 都缺）');
  }

  // ── 每个声明 facet 的入口存在性 + 说明符 ──
  for (const facet of facets) {
    const entry = detectFacetEntry(absDir, facet);
    if (facet === 'web') {
      const webDir = path.join(absDir, 'web');
      const js = existsSync(webDir) ? readdirSync(webDir).filter((n) => n.endsWith('.js')) : [];
      const ts = existsSync(webDir) ? readdirSync(webDir).filter((n) => n.endsWith('.ts')) : [];
      if (js.length === 0) {
        push('error', 'web-artifact-missing', 'web/ 下没有 .js 产物（平台不替第三方编译，请提供编译后的 .js）', webDir);
      }
      if (ts.length > 0) {
        push('error', 'web-ts-source', `web/ 下有 .ts 源文件（${ts.join(', ')}）—— 请先编译成 .js`, webDir);
      }
      // web 产物必须是可被浏览器直接加载的 ESM：不许裸说明符、不许 node builtin
      for (const file of listFiles(webDir, '.js')) {
        const code = readFileSync(file, 'utf-8');
        if (/\brequire\s*\(/.test(stripComments(code))) {
          push('error', 'web-cjs', '浏览器无法执行 CommonJS（require）', path.relative(absDir, file));
        }
        for (const { spec } of extractSpecifiers(code)) {
          if (spec.startsWith('.') || spec.startsWith('/')) continue;
          if (NODE_BUILTINS.has(spec) || spec.startsWith('node:')) {
            push('error', 'web-node-builtin', `web 产物引用了 Node 内建 ${spec}`, path.relative(absDir, file));
            continue;
          }
          push(
            'error',
            'web-bare-specifier',
            `web 产物含裸说明符 '${spec}' —— 浏览器没有 import map，挂载时必然失败`,
            path.relative(absDir, file),
          );
        }
      }
      continue;
    }

    if (!entry.exists) {
      push('error', 'facet-entry-missing', `${facet} 缺少入口文件（期望 ${entry.candidates.join(' 或 ')}）`);
      continue;
    }
    const code = readFileSync(entry.path, 'utf-8');
    if (/\brequire\s*\(/.test(stripComments(code))) {
      push('error', 'facet-cjs', `${facet} 入口必须是 ESM（发现 require()）`, path.relative(absDir, entry.path));
    }
    for (const { spec, typeOnly } of extractSpecifiers(code)) {
      if (typeOnly) continue;
      const hit = PLATFORM_RUNTIME_PACKAGES.find((p) => spec === p || spec.startsWith(`${p}/`));
      if (hit) {
        push(
          'error',
          'platform-runtime-import',
          `运行期 import 了 '${hit}' —— 该包只提供类型（不会出现在安装产物里）`,
          path.relative(absDir, entry.path),
        );
      }
    }
  }

  // ── web 产物的主题变量：只能用平台承诺的（否则暗色下白底 = fallback 生效）──
  const webDir = path.join(absDir, 'web');
  if (existsSync(webDir)) {
    const known = new Set<string>(PLATFORM_THEME_VARS);
    const unknown = new Map<string, string>();
    for (const name of readdirSync(webDir)) {
      if (!name.endsWith('.js')) continue;
      const code = readFileSync(path.join(webDir, name), 'utf8');
      for (const m of code.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
        const v = m[1]!.toLowerCase();
        if (!known.has(v) && !unknown.has(v)) unknown.set(v, name);
      }
    }
    for (const [v, file] of unknown) {
      push(
        'warning',
        'theme-var-unknown',
        `用了平台未承诺的 CSS 变量 ${v}（暗色下会走 fallback，通常是白底）`,
        path.relative(absDir, path.join('web', file)),
      );
    }
  }

  // ── 插件自带 skill（数据目录，不是 facet）：有 skills/ 就必须满足 pi 的 skill 契约 ──
  const skillsRoot = path.join(absDir, 'skills');
  if (existsSync(skillsRoot)) {
    const dirs = readdirSync(skillsRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    if (dirs.length === 0) {
      push('warning', 'skills-empty', `skills/ 目录没有任何 skill 子目录`, 'skills');
    }
    for (const d of dirs) {
      const skillFile = path.join(skillsRoot, d.name, 'SKILL.md');
      if (!existsSync(skillFile)) {
        push('error', 'skill-missing-file', `skill『${d.name}』缺少 SKILL.md（pi 的 skill 契约要求）`, path.relative(absDir, path.join('skills', d.name)));
        continue;
      }
      // frontmatter 必须有 name / description —— 少了 pi 会静默不加载。
      const head = readFileSync(skillFile, 'utf8').slice(0, 600);
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
      if (!fm) {
        push('error', 'skill-no-frontmatter', `skill『${d.name}』的 SKILL.md 缺少 frontmatter（--- name/description ---）`, path.relative(absDir, skillFile));
        continue;
      }
      for (const key of ['name', 'description']) {
        if (!new RegExp(`^${key}\\s*:`, 'm').test(fm[1] ?? '')) {
          push('error', 'skill-frontmatter-field', `skill『${d.name}』的 frontmatter 缺少 \`${key}\``, path.relative(absDir, skillFile));
        }
      }
    }
  }

  return { ok: !issues.some((i) => i.level === 'error'), id, dir: absDir, facets, issues };
}

/** 把检查结果渲染成 CLI 可打印的文本行。 */
export function formatCheckResult(result: PluginCheckResult): string[] {
  const lines: string[] = [];
  lines.push(`${result.id}  (${result.facets.join(', ') || '无 facet'})  ${result.ok ? 'OK' : 'FAILED'}`);
  for (const issue of result.issues) {
    lines.push(`  ${issue.level === 'error' ? '✗' : '!'} [${issue.code}] ${issue.message}${issue.file ? `  (${issue.file})` : ''}`);
  }
  return lines;
}
