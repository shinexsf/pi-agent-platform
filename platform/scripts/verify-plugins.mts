/**
 * 插件机制的可执行验收（change: plugin-mechanism-v2 / §11）。
 *
 * 一个**进程内、无 HTTP** 的验收脚手架：真的写插件目录、真的 `import()` 执行、
 * 真的重载。断言的六件事就是这套机制的六条承诺：
 *
 *   A. 注册齐 —— fixture 覆盖 10 个扩展点，`rejected` 为 0
 *   B. 零副作用 —— 模块顶层注册会被断言拦下并拒绝整个插件
 *   C. 真热加载 —— 改代码后 reload 跑的是**新代码**（不是模块缓存）
 *   D. 注销干净 —— reload 后注册总量回到基线（disposer 账本无泄漏）
 *   E. 拒绝可见 —— 重名 / 未定义槽位 / 非法路由模式一律进 `rejected` 且带原因
 *   F. 不兼容不执行 —— apiVersion 不匹配的插件一行代码都不跑
 *
 * 为什么不用 curl：这些都是"装载器内部行为"，HTTP 层只是消费者的消费结果。
 * 进程内跑还顺带证明了内核不依赖入口应用（和 `verify:sdk` 同款边界）。
 *
 * 跑法（在 platform/ 下）：
 *   pnpm verify:plugins
 */

import path from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 打包态环境变量先剥掉（原因见 verify-sdk.mts：会指向全局安装的另一份代码）。
for (const k of [
  'PI_SERVER_CLI', 'WORKER_DIST_DIR', 'PI_DATA_DIR',
  'PI_ATTACHMENTS_ROOT', 'PI_LOG_FILE', 'CHANNELS_DIR', 'PUBLIC_DIR',
]) {
  delete process.env[k];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const platformRoot = path.resolve(here, '..');
const repoRoot = path.resolve(platformRoot, '..');
/** 测试产物一律放 test-workspace/（硬约定），每次重建。 */
const runDir = path.join(repoRoot, 'test-workspace', 'plugins-verify');
const pluginsDir = path.join(runDir, 'plugins');
const dbPath = path.join(runDir, 'verify.db');

const {
  getPluginSnapshot,
  loadPluginExtensions,
  disposeAllExtensions,
  registrationCount,
  extensionSummary,
  getPluginExtensions,
  dispatchPluginRoute,
  normalizePath,
  initDb,
} = await import(path.join(platformRoot, 'packages/core/src/index.js') as string);

// ── 断言工具 ───────────────────────────────────────────────────────────────

let failures = 0;
function check(ok: boolean, label: string, detail?: unknown): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failures += 1;
  console.error(`  ✗ ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
}
function section(title: string): void {
  console.log(`\n${title}`);
}

// ── 1. 造 fixture 插件 ─────────────────────────────────────────────────────

rmSync(runDir, { recursive: true, force: true });
mkdirSync(pluginsDir, { recursive: true });

function writePlugin(id: string, files: Record<string, string>, apiVersion = '1'): void {
  const dir = path.join(pluginsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: id, version: '0.0.1', type: 'module', piServer: { apiVersion } }, null, 2),
  );
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/** 覆盖 10 个扩展点的"好插件"。 */
writePlugin('fixture-full', {
  'server/index.js': `
// 顶层零副作用：只允许 import 与导出对象。
export default {
  async init(host) {
    // R4 表迁移 + db 读写
    host.db.migrate('fixture_notes', 'CREATE TABLE IF NOT EXISTS fixture_notes (id TEXT PRIMARY KEY, body TEXT)');
    host.db.query('INSERT OR REPLACE INTO fixture_notes (id, body) VALUES (?, ?)', ['k', 'MARKER_A']);
    // 能力面（stub host 上必须可调用）
    await host.sessions.list();
    await host.agents.list();
    host.lifecycle.onSessionCreated(() => {});
    host.lifecycle.onSessionDisposed(() => {});

    // R1 页面（菜单 + 路由一次注册）
    host.ui.page({ path: '/fixture', label: 'Fixture', icon: 'beaker', component: 'page', order: 900 });
    // R9 挂载点
    host.ui.slot({ slot: 'chat.rail.right', id: 'fixture-panel', title: 'Fixture', component: 'panel' });
    // R10 工具卡
    host.ui.toolCard({ tool: 'fixture_tool', mode: 'replace', entry: 'card' });
    // R2 HTTP 路由（字面量 + 命名参数 + 通配）
    host.http.route({ method: 'GET', path: '/hello', handler: () => ({ json: { ok: true } }) });
    host.http.route({ method: 'GET', path: '/item/:id', handler: (req) => ({ json: { id: req.params.id } }) });
    host.http.route({ method: 'POST', path: '/hooks/*', handler: (req) => ({ json: { raw: req.path, wildcard: req.params['*'] } }) });
    // R3 反向方法
    host.methods.handle('ping', (params) => ({ pong: params }));
  },
  dispose() { globalThis.__fixtureDispose = (globalThis.__fixtureDispose ?? 0) + 1; },
};
`,
  'worker/index.js': `
export default {
  init(host) {
    // R5 正向方法
    host.methods.handle('scan', (params) => ({ scanned: params }));
  },
};
`,
  'extension/index.js': `
// R6 工具 / R7 命令 / R8 钩子
export default async function (pi, ctx) {
  pi.registerTool?.({ name: 'fixture_tool', description: 'fixture', execute: () => 'ok' });
  pi.registerCommand?.('fixture-cmd', { handler: () => 'ok' });
  pi.on?.('session_start', () => {});
  ctx?.bridge?.registerMethod?.('emit', (data) => data);
}
`,
  'web/page.js': `export function mount(el) { el.textContent = 'page-v1'; }`,
  'web/panel.js': `export function mount(el) { el.textContent = 'panel'; }`,
  'web/card.js': `export function mount(el) { el.textContent = 'card'; }`,
});

/** 非法注册：重名 / 未定义槽位 / 非法路由模式，全部必须进 `rejected`。 */
writePlugin('fixture-illegal', {
  'server/index.js': `
export default {
  init(host) {
    host.ui.page({ path: '/illegal', label: 'Illegal', component: 'x' });
    host.http.route({ method: 'GET', path: '/dup', handler: () => ({}) });
    host.http.route({ method: 'GET', path: '/dup', handler: () => ({}) });          // 重名
    host.http.route({ method: 'GET', path: '/h*', handler: () => ({}) });           // * 不独占一段
    host.http.route({ method: 'GET', path: '/a/*/b', handler: () => ({}) });        // * 不是末段
    host.ui.slot({ slot: 'chat.rail.left', id: 'x', component: 'x' });              // 未定义槽位
    host.ui.slot({ slot: 'chat.rail.right', id: 'y', component: 'missing' });       // 入口不存在
    host.ui.toolCard({ tool: 't', mode: 'regions', regions: { banner: 'card' } });  // 未知区域
    host.methods.handle('', () => ({}));                                            // 空方法名
  },
};
`,
  // 工具卡的区域校验要求入口文件先存在，所以补一个入口（否则先撞"文件不存在"）
  'web/card.js': `export function mount(el) { el.textContent = 'illegal-card'; }`,
});

/** 反例：把 host 偷存到 globalThis，然后在模块顶层注册（reload 时才会触发）。 */
writePlugin('fixture-toplevel', {
  'server/index.js': `
const stashed = globalThis.__fixtureTopLevelHost;
if (stashed) {
  stashed.http.route({ method: 'GET', path: '/sneaky', handler: () => ({ json: { sneaky: true } }) });
}
export default {
  init(host) { globalThis.__fixtureTopLevelHost = host; },
};
`,
});

/** 反例：apiVersion 不匹配 —— 一行代码都不许执行。 */
writePlugin(
  'fixture-oldapi',
  {
    'server/index.js': `
globalThis.__fixtureOldApiRan = true;
export default { init() {} };
`,
  },
  '0',
);

writeFileSync(
  path.join(pluginsDir, 'registry.json'),
  JSON.stringify(
    {
      version: 1,
      plugins: ['fixture-full', 'fixture-illegal', 'fixture-toplevel', 'fixture-oldapi'].map((id) => ({
        id,
        dir: path.join(pluginsDir, id),
        enabled: true,
      })),
    },
    null,
    2,
  ),
);

// ── 2. 桩宿主（真实 db + 记录型其余面）────────────────────────────────────

const { db, raw } = initDb(dbPath);
let serviceRegistrations = 0;
const reverseMethods: Record<string, string[]> = {};

const stubHost = {
  db: {
    migrate(name: string, ddl: string) {
      raw.exec(ddl);
      globalThis.__migrated = [...((globalThis.__migrated as string[]) ?? []), name];
    },
    query(sql: string, params?: unknown[]) {
      const stmt = raw.prepare(sql);
      const args = params && params.length > 0 ? params : undefined;
      if (!stmt.reader) {
        (args ? stmt.run(...args) : stmt.run());
        return [];
      }
      return args ? stmt.all(...args) : stmt.all();
    },
  },
  sessions: {
    call: async () => ({}),
    get: () => null,
    list: () => [{ id: 's1', agentId: 'a1', status: 'idle', hasRow: true }],
    status: () => 'idle',
    hasRow: () => true,
    subscribe: () => () => {},
  },
  agents: {
    list: () => [{ id: 'a1', name: 'agent' }],
    get: () => ({ id: 'a1', name: 'agent' }),
    update: () => {},
  },
  lifecycle: {
    onSessionCreated: () => () => {},
    onSessionDisposed: () => () => {},
  },
};

const deps = {
  host: stubHost as never,
  registerService(source: string, _kind: string, handlers: Record<string, unknown>) {
    serviceRegistrations += 1;
    reverseMethods[source] = Object.keys(handlers);
  },
};

// ── 3. 装载 + 断言 A/F ────────────────────────────────────────────────────

section('1) 首次装载');
const snapshot = getPluginSnapshot(pluginsDir);
const byId = new Map(snapshot.plugins.map((p) => [p.entry.id, p]));
check(byId.get('fixture-full')?.status === 'active', 'fixture-full 判定为 active');
check(byId.get('fixture-oldapi')?.status === 'degraded', 'apiVersion 不匹配 → degraded', byId.get('fixture-oldapi')?.reason);

await loadPluginExtensions(snapshot, deps);

const full = getPluginExtensions('fixture-full');
check(full.pages.length === 1, 'R1 页面注册成功', full.pages);
check(full.surfaces.length === 1, 'R9 挂载点注册成功', full.surfaces);
check(full.toolCards.length === 1, 'R10 工具卡注册成功', full.toolCards);
check(full.routes.length === 3, 'R2 三条路由注册成功（字面量 / :param / *）', full.routes);
check(full.rejected.length === 0, 'fixture-full 无被拒项', full.rejected);
check(!!reverseMethods['plugin:fixture-full'], 'R3 反向方法挂到分发表', reverseMethods);
check(
  (globalThis.__migrated as string[] | undefined)?.includes('fixture_notes') === true,
  'R4 迁移被执行并记名',
);
check(
  (globalThis as { __fixtureOldApiRan?: boolean }).__fixtureOldApiRan !== true,
  'F 不兼容插件的代码一行都没执行',
);

section('2) 拒绝可见（E）');
const illegal = getPluginExtensions('fixture-illegal');
const reasons = illegal.rejected.map((r) => `${r.kind}:${r.reason}`);
check(illegal.rejected.length === 7, `非法注册 7 条全部进 rejected（实际 ${illegal.rejected.length}）`, reasons);
check(reasons.some((r) => r.includes('重复注册')), '同 method+path 重名被拒');
check(reasons.some((r) => r.includes('只能作为最后一段')), '* 非末段被拒');
check(reasons.some((r) => r.includes('必须独占一段')), '* 不独占一段被拒');
check(reasons.some((r) => r.includes('未知槽位')), '未定义槽位被拒');
check(reasons.some((r) => r.includes('入口文件不存在')), '缺失 web 入口被拒');
check(reasons.some((r) => r.includes('未知区域')), '未知工具卡区域被拒');
check(reasons.some((r) => r.includes('方法名必须是非空字符串')), '空方法名被拒');

// ── 4. 分发断言（R2 三条路径）────────────────────────────────────────────

section('3) 路由分发');
const ctxFor = (method: string, p: string) => ({
  method,
  path: p,
  query: {},
  body: '{"x":1}',
  headers: new Headers(),
});
const isEnabled = (id: string) => byId.get(id)?.status === 'active';

const hello = await dispatchPluginRoute('fixture-full', ctxFor('GET', '/hello'), isEnabled);
check((hello as { json?: { ok?: boolean } })?.json?.ok === true, '字面量路由命中');

const item = await dispatchPluginRoute('fixture-full', ctxFor('GET', '/item/42'), isEnabled);
check((item as { json?: { id?: string } })?.json?.id === '42', ':param 解出参数');

const hook = await dispatchPluginRoute('fixture-full', ctxFor('POST', '/hooks/github/push'), isEnabled);
check(
  (hook as { json?: { wildcard?: string } })?.json?.wildcard === 'github/push',
  '* 通配段拿到剩余路径',
);

const miss = await dispatchPluginRoute('fixture-full', ctxFor('GET', '/nope'), isEnabled);
check(miss === null, '未匹配返回 null（交给上层 404）');

// ── 5. 热加载（C）+ 账本（D）+ 零副作用（B）──────────────────────────────

section('4) 热加载与账本');
const baseline = registrationCount();
const beforeSummary = extensionSummary();

// 改一处字符串：只有真的重新 import 才会看到新值
const serverFile = path.join(pluginsDir, 'fixture-full', 'server', 'index.js');
const original = (await import('node:fs')).readFileSync(serverFile, 'utf8');
writeFileSync(serverFile, original.replace('MARKER_A', 'MARKER_B'));

const reloadSnapshot = getPluginSnapshot(pluginsDir);
await loadPluginExtensions(reloadSnapshot, deps);
check(
  extensionSummary().imports > beforeSummary.imports,
  `reload 确实重新 import 了（imports ${beforeSummary.imports} → ${extensionSummary().imports}）`,
);
check(registrationCount() === baseline, `D reload 后注册总量回到基线（${registrationCount()} = ${baseline}）`);
check(
  (globalThis.__fixtureDispose as number | undefined) === 1,
  'dispose() 在 reload 前被调用一次',
);

// 新代码生效：db 里的 marker 应该被第二次写入覆盖成 MARKER_B
const marker = raw.prepare('SELECT body FROM fixture_notes WHERE id = ?').get('k') as { body?: string };
check(marker?.body === 'MARKER_B', `C 新代码生效（marker=${marker?.body}）`);

check(
  getPluginExtensions('fixture-toplevel').routes.length === 0,
  'B 顶层注册被断言拦下（sneaky 路由不存在）',
  getPluginExtensions('fixture-toplevel').routes,
);
check(
  (getPluginExtensions('fixture-toplevel').registerError ?? '').includes('顶层'),
  'B 拒绝原因写明"顶层不得注册"',
  getPluginExtensions('fixture-toplevel').registerError,
);

// ── 6. worker / extension facet（R5–R8）──────────────────────────────────
// 这两类装载点在**另一个进程**（session worker）里执行，server 侧装载器不 import 它们。
// 验收方式：按 worker 的方式直接调用，断言它们在给定 (host | pi, ctx) 下注册了东西。

section('5) worker / extension 装载点');
const workerMod = (await import(`file://${path.join(pluginsDir, 'fixture-full', 'worker', 'index.js')}`)) as {
  default: { init(host: unknown): void };
};
const workerMethods: string[] = [];
workerMod.default.init({
  id: 'fixture-full',
  dir: pluginsDir,
  log: () => {},
  methods: { handle: (name: string) => workerMethods.push(name) },
});
check(workerMethods.includes('scan'), 'R5 worker 正向方法注册');

const extMod = (await import(`file://${path.join(pluginsDir, 'fixture-full', 'extension', 'index.js')}`)) as {
  default: (pi: unknown, ctx: unknown) => Promise<void>;
};
const extCalls: string[] = [];
await extMod.default(
  {
    registerTool: (def: { name: string }) => extCalls.push(`tool:${def.name}`),
    registerCommand: (name: string) => extCalls.push(`command:${name}`),
    on: (event: string) => extCalls.push(`on:${event}`),
  },
  { bridge: { registerMethod: (name: string) => extCalls.push(`bridge:${name}`) } },
);
check(extCalls.includes('tool:fixture_tool'), 'R6 工具注册');
check(extCalls.includes('command:fixture-cmd'), 'R7 命令注册');
check(extCalls.includes('on:session_start'), 'R8 钩子注册');
check(extCalls.includes('bridge:emit'), 'extension 拿到 bridge（ctx 注入）');

// ── 6b. inline 插件：工具归属与白名单 ────────────────────────────────────
// inline 插件编译进平台、不可卸载，但必须走同一条"声明 → 白名单过滤 → 注入"路径。

section('6) inline 插件（工具归属）');
const { createServerTools } = (await import(
  path.join(platformRoot, 'workers/session-worker/src/tools.js') as string
)) as {
  createServerTools(
    sessionId: string,
    callMaster: (m: string, a: unknown[]) => Promise<unknown>,
    opts?: { serverBuiltinTools?: string[]; capabilityIndex?: unknown[] },
  ): Array<{ name: string }>;
};
const noopCall = async () => ({});

const withWhitelist = createServerTools('s1', noopCall, { serverBuiltinTools: ['callServer'], capabilityIndex: [] });
check(withWhitelist.some((t) => t.name === 'callServer'), 'inline 插件提供的 callServer 在白名单内时注入');

const withoutWhitelist = createServerTools('s1', noopCall, { serverBuiltinTools: [] });
check(
  !withoutWhitelist.some((t) => t.name === 'callServer'),
  '白名单为空 → inline 工具不注入（声明 ≠ 对该 agent 开放）',
);

const mixed = createServerTools('s1', noopCall, { serverBuiltinTools: ['sendFileToUser', 'callServer'] });
check(
  mixed.some((t) => t.name === 'sendFileToUser') && mixed.some((t) => t.name === 'callServer'),
  '过渡期两类来源并存（硬编码壳 + inline 声明）互不干扰',
);

// ── 7. 收尾 ───────────────────────────────────────────────────────────────

await disposeAllExtensions();
check(registrationCount() === 0, '全部卸载后注册表归零');
raw.close();
rmSync(runDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '✓ verify-plugins 通过：10 个扩展点 / 零副作用 / 热加载 / 账本 / 拒绝可见' : `✗ verify-plugins 失败：${failures} 条断言不通过`}`);
process.exit(failures === 0 ? 0 : 1);
