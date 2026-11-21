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

const {
  initCoreConfig, initDb, createAgentRepo, createSessionRepo, WorkerPool, initSessionRegistry, sessionRegistry,
  coreConfig, createPluginBus, buildSystemEnvelope, systemEventPromptOptions,
} = await import(path.join(platformRoot, 'packages/core/src/index.js') as string);
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
  bundledPluginsDir: undefined,
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
// plugin_migrations 是内核的台账表（插件迁移登记，change: plugin-mechanism-v2），
// 内核建它、插件写它 —— 所以它属于"内核对象的表"这一侧。
const expected = ['agents', 'attachments', 'plugin_migrations', 'sessions'];
if (JSON.stringify(tables) !== JSON.stringify(expected)) {
  console.error(`✗ 内核表不符：得到 [${tables.join(', ')}]，期望 [${expected.join(', ')}]`);
  process.exit(1);
}
console.log(`  ✓ 内核只建自己的表：${tables.join(', ')}`);

// ── 命名空间：两个互不相交的名字空间，注册表里不存在裸名 ──
{
  const ipc = await import(path.join(platformRoot, 'packages/ipc-protocol/src/index.js') as string);
  const reg = new ipc.IpcMethodRegistry();
  const check = (cond: boolean, msg: string): void => {
    if (cond) return;
    console.error(`✗ ${msg}`);
    process.exit(1);
  };
  const ok = { direction: 'forward' as const, source: 'core' as const, kind: 'mirror' as const };

  check(ipc.coreMethodName('prompt') === '__core__.prompt', 'coreMethodName 拼 __core__.');
  check(ipc.pluginMethodPrefix('acp') === 'acp.', 'pluginMethodPrefix 不带 plugin. 段');
  check(ipc.isReservedPluginId('__core__'), '插件 id 保留字判定');
  check(!ipc.isReservedPluginId('acp'), '普通 id 不受保留字影响');

  check(reg.register('prompt', ok, () => 1) === undefined, '裸名内核方法被拒（必须带 __core__）');
  check(reg.register('__core__.prompt', ok, () => 1) !== undefined, '__core__.prompt 可注册');

  const pluginOpt = { direction: 'forward' as const, source: 'plugin:acp' as const, kind: 'plugin' as const };
  check(reg.register('acp.emit', pluginOpt, () => 1) !== undefined, '插件方法 <id>.<name> 可注册');
  check(reg.register('emit', pluginOpt, () => 1) === undefined, '插件方法缺自己 id 前缀被拒');
  check(reg.register('__core__.steal', pluginOpt, () => 1) === undefined, '插件不许进 __core__ 保留空间');
  check(
    reg.rejected().some((r) => r.reason.includes('__core__')),
    '被拒原因指出版本空间冲突',
  );
  console.log('  ✓ IPC 命名：__core__ / <pluginId>. 两个空间，裸名与越界均被拒');
}

// ── 动作入参校验（一处实现，tool / service / reverse / http 共用）──
{
  const { validateParams } = await import(
    path.join(platformRoot, 'packages/ipc-protocol/src/action-params.js') as string
  );
  const schema = {
    type: 'object',
    properties: { name: { type: 'string', minLength: 1 }, n: { type: 'integer', minimum: 1 } },
    required: ['name'],
    additionalProperties: false,
  };
  const okRes = validateParams(schema, { name: 'x', n: 2 });
  if (!okRes.ok) {
    console.error(`✗ 合法入参被拒：${okRes.message}`);
    process.exit(1);
  }
  const missing = validateParams(schema, { n: 2 });
  const tooSmall = validateParams(schema, { name: 'x', n: 0 });
  const extra = validateParams(schema, { name: 'x', extra: 1 });
  const wrongType = validateParams(schema, { name: 1 });
  if (missing.ok || tooSmall.ok || extra.ok || wrongType.ok) {
    console.error('✗ 非法入参未被拒');
    process.exit(1);
  }
  if (validateParams(undefined, 'anything').ok !== true) {
    console.error('✗ 无 schema 时不该校验');
    process.exit(1);
  }
  console.log('  ✓ 入参校验：required / 类型 / 范围 / additionalProperties 都拦住');
}

// ── 动作归属：reach 只约束反向方法来源，来源由桥注入 ──
{
  const { createPluginActions } = await import(
    path.join(platformRoot, 'packages/core/src/services/plugin-actions.js') as string
  );
  const acts = createPluginActions();
  const h = () => ({ ok: true });
  acts.define('alpha', {
    private: { params: { type: 'object' }, handler: h },                        // 默认 own
    shared: { params: { type: 'object' }, handler: h, scope: 'public' },
  });
  const check2 = (cond: boolean, msg: string): void => {
    if (cond) return;
    console.error(`✗ ${msg}`);
    process.exit(1);
  };
  const reachOf = (name: string) => acts.reachOf(name);
  // master 的判定规则：`reach === 'own' && source !== owner` → unknown method
  const allowed = (method: string, source: string): boolean => {
    const reach = reachOf(method);
    const owner = method.split('.')[0];
    return !(reach === 'own' && source !== owner);
  };
  check2(allowed('alpha.private', 'alpha'), 'own 动作：owner 自己可调');
  check2(!allowed('alpha.private', 'beta'), 'own 动作：别的插件被拒（不泄漏存在性）');
  check2(allowed('alpha.shared', 'beta'), 'public 动作：别的插件放行');
  check2(reachOf('nope.nothing') === undefined, '非动作方法不做归属校验（插件自有反向方法不受影响）');
  console.log('  ✓ 动作归属：own 只认 owner / public 放行 / 非动作不校验');
}

// ── 宿主面：events 总线（进程内、无回执、退订归零）──
const bus = createPluginBus();
const seen: unknown[] = [];

// 未声明 → unknown-topic（拒绝，不静默成功）
const beforeDeclare = bus.publish('probe', 'probe.topic', { n: 0 });
if (beforeDeclare.ok || beforeDeclare.reason !== 'unknown-topic') {
  console.error(`✗ 未声明 topic 应返回 unknown-topic，实际 ${JSON.stringify(beforeDeclare)}`);
  process.exit(1);
}

const declared = bus.declare('probe', 'probe.topic', { declaredBy: 'publisher' });
if (!declared.ok) {
  console.error(`✗ 合法声明失败：${JSON.stringify(declared)}`);
  process.exit(1);
}

// 前缀不符 → 拒绝
const badPrefix = bus.declare('probe', 'other.topic', { declaredBy: 'publisher' });
if (badPrefix.ok) {
  console.error('✗ 前缀不符的声明应被拒');
  process.exit(1);
}

// 冒名发布 → not-owner
const spoof = bus.publish('other', 'probe.topic', { n: 1 });
if (spoof.ok || spoof.reason !== 'not-owner') {
  console.error(`✗ 非 owner 发布应返回 not-owner，实际 ${JSON.stringify(spoof)}`);
  process.exit(1);
}

const subA = bus.subscribe('probe', 'probe.topic', (p) => seen.push(p));
const subB = bus.subscribe('probe', 'probe.topic', () => {
  throw new Error('订阅者抛错不应影响别人');
});
if (subA.state !== 'matched') {
  console.error(`✗ 已声明 topic 订阅应为 matched，实际 ${subA.state}`);
  process.exit(1);
}
const sent = bus.publish('probe', 'probe.topic', { n: 1 });
if (!sent.ok || sent.delivered !== 2 || seen.length !== 1) {
  console.error(`✗ 派发异常：${JSON.stringify(sent)} seen=${seen.length}`);
  process.exit(1);
}

// pending 订阅：先订阅后声明
const pendingSub = bus.subscribe('probe', 'probe.late', (p) => seen.push(p));
if (pendingSub.state !== 'pending') {
  console.error(`✗ 未声明 topic 订阅应为 pending，实际 ${pendingSub.state}`);
  process.exit(1);
}
bus.declare('probe', 'probe.late', { declaredBy: 'publisher' });
bus.publish('probe', 'probe.late', { n: 2 });
if (seen.length !== 2) {
  console.error(`✗ pending 订阅未在声明后生效：seen=${seen.length}`);
  process.exit(1);
}

// 无订阅者是正常态
bus.declare('probe', 'probe.silent', { declaredBy: 'publisher' });
const silent = bus.publish('probe', 'probe.silent', {});
if (!silent.ok || silent.delivered !== 0) {
  console.error(`✗ 无订阅者应为 {ok:true,delivered:0}，实际 ${JSON.stringify(silent)}`);
  process.exit(1);
}

// handler 返回值被丢弃 + publishAndWait 只回报成败
const waited = await bus.publishAndWait('probe', 'probe.topic', { n: 3 });
if (!waited.ok || waited.handled !== 1 || waited.failed !== 1) {
  console.error(`✗ publishAndWait 统计不符：${JSON.stringify(waited)}`);
  process.exit(1);
}

subA.dispose();
subA.dispose(); // 幂等退订
subB.dispose();
pendingSub.dispose();
if (bus.subscriberCount() !== 0) {
  console.error(`✗ 退订后订阅数应为 0，实际 ${bus.subscriberCount()}`);
  process.exit(1);
}
bus.disposePlugin('probe');
if (bus.topics().length !== 0) {
  console.error(`✗ disposePlugin 后 topic 应清空，实际 ${bus.topics().length}`);
  process.exit(1);
}
bus.clear();
console.log('  ✓ bus 面：声明/前缀/冒名/送达计数/pending/同步统计/幂等退订/归零');

// ── 信封：唯一构造点，`</data` 被转义，指令原样保留 ──
const envelope = buildSystemEnvelope({
  kind: 'trigger',
  source: 'cron',
  name: 'probe',
  fired: '2026-11-19T00:00:00.000Z',
  run: 'run_1',
  instruction: '检查磁盘',
  data: { note: '</data><evil>' },
});
if (!envelope.startsWith('<system-event v="1" kind="trigger" source="cron" name="probe"')) {
  console.error(`✗ 信封属性顺序/形状变了：${envelope.slice(0, 80)}`);
  process.exit(1);
}
if (!envelope.includes('<\\/data><evil>') || envelope.includes('</data><evil>')) {
  console.error('✗ 信封没有转义 </data');
  process.exit(1);
}
if (!envelope.includes('<instruction>检查磁盘</instruction>')) {
  console.error('✗ 信封丢了 instruction');
  process.exit(1);
}
console.log('  ✓ system-envelope：属性驱动 / `</data` 转义 / instruction 原样');

// ── prompt 选项：`streamingBehavior` 是 pi 的硬契约（忙时不给就报错）──
if (JSON.stringify(systemEventPromptOptions()) !== '{}') {
  console.error('✗ 不传 streamingBehavior 时选项必须是 {}（既有调用方零影响）');
  process.exit(1);
}
if (systemEventPromptOptions('followUp').streamingBehavior !== 'followUp') {
  console.error('✗ streamingBehavior=followUp 没有透传');
  process.exit(1);
}
if (systemEventPromptOptions('steer').streamingBehavior !== 'steer') {
  console.error('✗ streamingBehavior=steer 没有透传');
  process.exit(1);
}
console.log('  ✓ systemEventPromptOptions：不传 → {} / followUp / steer 原样透传');

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

// ── sessions.ensure 三态（插件"无人值守跑一轮"的入口）──
const ensured = await sessionRegistry().ensure({ agentId: agent.id, title: '[probe]' });
if (!ensured.created || !sessionRepo.get(ensured.sessionId)) {
  console.error('✗ ensure(新建) 没有落行');
  process.exit(1);
}
const ensuredAgain = await sessionRegistry().ensure({ agentId: agent.id, sessionId: ensured.sessionId });
if (ensuredAgain.created || ensuredAgain.sessionId !== ensured.sessionId) {
  console.error('✗ ensure(复用) 语义错');
  process.exit(1);
}
let strangerRejected = false;
try {
  await sessionRegistry().ensure({ agentId: agent.id, sessionId: 'no-such-session' });
} catch {
  strangerRejected = true;
}
if (!strangerRejected) {
  console.error('✗ ensure 对陌生 sessionId 必须抛错（fail closed）');
  process.exit(1);
}
await workerPool.kill(ensured.sessionId, 'verify-sdk-cleanup');
console.log('  ✓ sessions.ensure：新建落行 / 复用不新建 / 陌生 id 抛错');

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
