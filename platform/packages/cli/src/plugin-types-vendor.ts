/**
 * vendored 类型交付（change: plugin-mechanism-v2 / D4）。
 *
 * 为什么不用 `peerDependencies`：`@pi-agent-platform/plugin-types` 是 **private** 包，
 * 不在 npm registry 上；CLI 的 peer 链接只从 `~/.pi/agent/npm/node_modules` 找，
 * 第三方开发者机器上必然解析失败。
 *
 * 所以类型以**文件**形式交付：`plugin add` / `plugin check` 把 `.d.ts` 写进插件目录，
 * 作者的 tsconfig 用 `paths` 指过去。文件里带 `PLUGIN_TYPES_VERSION`，
 * check 时与平台侧比对 —— 类型漂移是可以被机械发现的，不需要靠人记得重新生成。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, warn } from './logger.js';

/** 与 `plugin-types/src/index.ts` 的 `PLUGIN_TYPES_VERSION` 保持一致（漂移由 check 抓）。 */
export const PLUGIN_TYPES_VERSION = '1';

/** 写进插件目录的位置（相对插件根）。 */
export const VENDORED_TYPES_DIR = path.join('types', 'plugin-types');

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 候选位置：打包态随 CLI 分发（`dist/server/plugin-types`）→ dev 态向上找 workspace 产物。
 *
 * 用"向上找"而不是写死相对层级：同一个文件会被 tsx 从 `src/` 跑、也会被 node 从
 * `dist/commands/` 跑，层级差一层就会静默找不到（然后 check 变成"跳过类型校验"）。
 */
function candidateTypeDirs(): string[] {
  const candidates: string[] = [];
  if (process.env.PI_PLUGIN_TYPES_DIR) candidates.push(process.env.PI_PLUGIN_TYPES_DIR);
  let dir = here;
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, 'dist', 'server', 'plugin-types'));
    candidates.push(path.join(dir, 'plugin-types', 'dist'));
    candidates.push(path.join(dir, 'packages', 'plugin-types', 'dist'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

export interface VendoredTypesResult {
  ok: boolean;
  written: string[];
  reason?: string;
}

/**
 * 把类型声明写进插件目录。
 *
 * 只覆盖 `.d.ts` —— 插件目录里除 `types/` 之外一切都不碰（这是别人的工程）。
 */
export function writeVendoredTypes(pluginDir: string): VendoredTypesResult {
  const source = candidateTypeDirs()
    .map((dir) => path.join(dir, 'index.d.ts'))
    .find((file) => existsSync(file));
  if (!source) {
    return { ok: false, written: [], reason: '找不到 plugin-types 的 .d.ts（打包产物缺 dist/server/plugin-types）' };
  }
  const targetDir = path.join(pluginDir, VENDORED_TYPES_DIR);
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(source, path.join(targetDir, 'index.d.ts'));

  const webSource = path.join(path.dirname(source), 'web.d.ts');
  if (existsSync(webSource)) copyFileSync(webSource, path.join(targetDir, 'web.d.ts'));

  // tsconfig 的 paths 示例：作者照着改即可，不替人改工程。
  const tsconfigHint = {
    compilerOptions: {
      paths: { '@pi-agent-platform/plugin-types': [`./${VENDORED_TYPES_DIR}/index.d.ts`] },
    },
  };
  writeFileSync(
    path.join(targetDir, 'tsconfig.hint.json'),
    `${JSON.stringify(tsconfigHint, null, 2)}\n`,
  );
  return { ok: true, written: ['index.d.ts', 'web.d.ts', 'tsconfig.hint.json'] };
}

/** 插件目录里已 vendored 的类型版本（读不到 → undefined）。 */
export function readVendoredTypesVersion(pluginDir: string): string | undefined {
  const file = path.join(pluginDir, VENDORED_TYPES_DIR, 'index.d.ts');
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, 'utf-8');
  const m = /PLUGIN_TYPES_VERSION:\s*'([^']+)'/.exec(raw);
  return m?.[1];
}

/** 校验并（必要时）刷新 vendored 类型。返回是否一致。 */
export function ensureVendoredTypes(pluginDir: string, opts: { quiet?: boolean } = {}): boolean {
  const existing = readVendoredTypesVersion(pluginDir);
  if (existing === PLUGIN_TYPES_VERSION) return true;
  const result = writeVendoredTypes(pluginDir);
  if (!result.ok) {
    warn(`vendored types skipped: ${result.reason}`);
    return false;
  }
  if (existing === undefined) log(`types written → ${VENDORED_TYPES_DIR}/`);
  else log(`types refreshed (${existing} → ${PLUGIN_TYPES_VERSION}) → ${VENDORED_TYPES_DIR}/`);
  void opts;
  return true;
}
