/**
 * 内核脱离 HTTP 的可执行验收（spec `core-sdk`）。
 *
 * 做两件事：
 *
 * **A. 静态断言**：`packages/core` 与 `packages/event-projection` 的 import 闭包内
 *    不得出现 `hono` / `@hono/node-server` / 静态托管模块 / 入口应用模块。
 *    用可执行的检查代替口头边界规则 —— 规则会腐化，检查不会。
 *
 * **B. 运行时断言**：在一个**没有任何 HTTP server** 的进程里
 *    initCoreConfig → initDb → repos → WorkerPool → SessionRegistry
 *    → 建 agent / 建会话 → 发一条消息 → 收到原生事件 → 投影出客户端 DTO。
 *
 * 跑法（在 platform/ 下）：
 *   pnpm verify:sdk
 *
 * 需要真实 provider 凭据（和平时一样从 ~/.pi/agent 读）。不想真跑一轮时设
 * `VERIFY_SDK_SKIP_ROUND=1`，只做静态断言与建会话。
 */

import path from 'node:path';
import { readFileSync, readdirSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// 打包态环境变量必须先剥掉：从 IDE / 已安装的 pi-server 里继承到 `PI_SERVER_CLI` +
// `WORKER_DIST_DIR` 时，worker 会去 spawn **全局安装的 dist**，于是内核跑的还是另一份
// 代码（旧投影、旧行为），而且不报任何错。dev 启动器做的就是这件事。
for (const k of [
  'PI_SERVER_CLI', 'WORKER_DIST_DIR', 'PI_DATA_DIR',
  'PI_ATTACHMENTS_ROOT', 'PI_LOG_FILE', 'CHANNELS_DIR', 'PUBLIC_DIR',
]) {
  delete process.env[k];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const platformRoot = path.resolve(here, '..');

// ── A. 静态断言：依赖闭包 ──────────────────────────────────────────────────

const FORBIDDEN = [
  { test: (s: string) => s === 'hono' || s.startsWith('hono/'), why: 'HTTP 框架' },
  { test: (s: string) => s === '@hono/node-server' || s.startsWith('@hono/node-server/'), why: 'HTTP server' },
  { test: (s: string) => /static-spa|startup-banner/.test(s), why: '入口应用的静态托管 / 启动横幅' },
  { test: (s: string) => /\/apps\/|\.\.\/\.\.\/apps/.test(s), why: '入口应用模块' },
];

const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

/** 列出包内全部 .ts（不跟随 node_modules）。 */
function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listSources(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 解析一个相对 import 到磁盘文件。 */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec).replace(/\.js$/, '');
  for (const cand of [base + '.ts', path.join(base, 'index.ts')]) {
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {
      /* not found */
    }
  }
  return null;
}

function checkImportClosure(pkgDir: string, label: string): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  const queue = listSources(path.join(pkgDir, 'src'));
  for (const f of queue) seen.add(f);

  for (const file of queue) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1]!;
      const hit = FORBIDDEN.find((r) => r.test(spec));
      if (hit) {
        violations.push(`${path.relative(platformRoot, file)} → '${spec}'（${hit.why}）`);
        continue;
      }
      const local = resolveSpec(file, spec);
      if (local && !seen.has(local)) {
        seen.add(local);
        queue.push(local);
      }
    }
  }
  console.log(`  ${label}: 扫描 ${queue.length} 个模块`);
  return violations;
}

console.log('A. 依赖闭包断言');
const violations = [
  ...checkImportClosure(path.join(platformRoot, 'packages/core'), 'packages/core'),
  ...checkImportClosure(path.join(platformRoot, 'packages/event-projection'), 'packages/event-projection'),
];
if (violations.length > 0) {
  console.error('✗ 依赖闭包违规：');
  for (const v of violations) console.error('   ' + v);
  process.exit(1);
}
console.log('  ✓ 无 HTTP / 入口应用依赖');

// ── B. 运行时断言 ──────────────────────────────────────────────────────────

console.log('B. 无 HTTP 进程内跑一轮会话');

const { initCoreConfig, initDb, createAgentRepo, createSessionRepo, WorkerPool, initSessionRegistry, sessionRegistry, coreConfig } =
  await import(path.join(platformRoot, 'packages/core/src/index.js') as string);
const { createSessionProjector } = await import(path.join(platformRoot, 'packages/event-projection/src/index.js') as string);

const runDir = path.join(platformRoot, '..', 'tmp', `verify-sdk-${process.pid}`);
mkdirSync(runDir, { recursive: true });
const dbPath = path.join(runDir, 'verify.db');
const attachmentsDir = path.join(runDir, 'attachments');
mkdirSync(attachmentsDir, { recursive: true });
const workspacePath = path.join(platformRoot, '..', 'test-workspace', 'sdk-probe');
mkdirSync(workspacePath, { recursive: true });

const agentDir = process.env.PI_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
const model = process.env.VERIFY_SDK_MODEL ?? 'deepseek/deepseek-flash';

initCoreConfig({
  maxWorkers: 2,
  agentDir,
  attachmentsDir,
  pluginsDir: path.join(path.dirname(agentDir), 'server', 'plugins'),
  serverBuiltinSkillsDir: undefined,
  mcpConfigPath: path.join(path.dirname(agentDir), 'server', 'mcp.json'),
  workerStartupTimeoutMs: 15_000,
  workerStopTimeoutMs: 5_000,
  isDev: true,
});
console.log(`  ✓ 配置注入（agentDir=${coreConfig().agentDir}）`);

const { db, raw } = initDb(dbPath);
const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
  .map((r) => r.name)
  .sort();
const expected = ['agents', 'attachments', 'sessions'];
if (JSON.stringify(tables) !== JSON.stringify(expected)) {
  console.error(`✗ 内核表不符：得到 [${tables.join(', ')}]，期望 [${expected.join(', ')}]`);
  process.exit(1);
}
console.log(`  ✓ 内核只建自己的表：${tables.join(', ')}`);

const agentRepo = createAgentRepo(db);
const sessionRepo = createSessionRepo(db);
const workerPool = new WorkerPool(2);
initSessionRegistry({ sessionRepo, agentRepo, workerPool });

const agent = agentRepo.create({
  name: 'sdk-probe',
  description: 'verify-sdk 自动创建',
  workspacePath,
  model,
  config: { extensions: [], skills: [], prompts: [], builtinTools: ['read'], mcp: { enabled: false, servers: [] } },
} as never);
console.log(`  ✓ 建 agent ${agent.id}`);

// 收集原生事件 + 投影
const projector = createSessionProjector();
const rawNames: string[] = [];
const projectedNames: string[] = [];
let assistantText = '';

let unsub: (() => void) | undefined;
const done = new Promise<void>((resolve) => {
  const timer = setTimeout(() => resolve(), 120_000);
  unsub = (() => {}) as never;
  void timer;
});

const session = await sessionRegistry().createFromAgent(agent.id);
console.log(`  ✓ 建会话 ${session.id}（placeholder，无 DB 行）`);

session.subscribe((event: { kind: string; event: string; data?: unknown }) => {
  rawNames.push(event.event);
  if (process.env.VERIFY_SDK_TRACE === '1') {
    console.log('EV ' + event.event + ' ' + JSON.stringify(event.data).slice(0, 200));
  }
  const projected = projector.project(event as never);
  if (!projected) return;
  projectedNames.push(projected.name);
  const d = projected.data as { role?: string; content?: string };
  // 极短的回复可能只有 message_start → message_end（合并窗口里没有中间快照），
  // 所以正文从两条里任取非空值。
  if ((projected.name === 'message_update' || projected.name === 'message_end')
      && d?.role === 'assistant' && typeof d.content === 'string' && d.content.length > 0) {
    assistantText = d.content;
  }
});

if (process.env.VERIFY_SDK_SKIP_ROUND !== '1') {
  await workerPool.call(session.id, 'prompt', ['只回两个字：收到']);
  // 等 agent_settled（或超时）
  await Promise.race([
    new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (rawNames.includes('agent_settled')) {
          clearInterval(check);
          resolve();
        }
      }, 200);
      setTimeout(() => { clearInterval(check); resolve(); }, 120_000);
    }),
    done,
  ]);
  console.log(`  ✓ 收到原生事件 ${rawNames.length} 条：${[...new Set(rawNames)].join(', ')}`);
  if (!rawNames.includes('message_update')) {
    console.error('✗ 没有收到 message_update');
    process.exit(1);
  }
  if (!projectedNames.includes('message_update')) {
    console.error('✗ 投影没有产出 message_update');
    process.exit(1);
  }
  if (!assistantText) {
    console.error('✗ 投影出的 assistant 正文为空');
    process.exit(1);
  }
  console.log(`  ✓ 投影出 DTO：assistant 正文 ${JSON.stringify(assistantText.slice(0, 40))}`);
} else {
  console.log('  · 跳过真跑一轮（VERIFY_SDK_SKIP_ROUND=1）');
}

unsub?.();
projector.dispose();
await workerPool.shutdown();
raw.close();
rmSync(runDir, { recursive: true, force: true });

console.log('\n✓ verify-sdk 通过：内核可以在没有 HTTP 的进程里跑完一轮会话');
process.exit(0);
