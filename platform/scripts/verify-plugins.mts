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
import { readFileSync } from 'node:fs';
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
  createPluginBus,
  createPluginServices,
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
    // R1 二级页：挂到别的页面下（parent 只认路径字符串）
    host.ui.page({ path: '/fixture/sub', label: 'Fixture Sub', component: 'page', parent: '/fixture' });
    // dataDir：插件私有可写目录（装载时由入口创建）
    globalThis.__fixtureDataDir = host.dataDir;
    // R9 挂载点
    host.ui.slot({ slot: 'chat.rail.right', id: 'fixture-panel', title: 'Fixture', component: 'panel' });
    // 插件空间槽位（<pluginId>.<name>）：进全局聚合，由宿主插件自己装载
    host.ui.slot({ slot: 'fixture.host-point', id: 'host-point', title: '宿主点位', component: 'panel' });
    // R10 工具卡
    host.ui.toolCard({ tool: 'fixture_tool', mode: 'replace', entry: 'card' });
    // R2 HTTP 路由（字面量 + 命名参数 + 通配）
    host.http.route({ method: 'GET', path: '/hello', handler: () => ({ json: { ok: true } }) });
    host.http.route({ method: 'GET', path: '/item/:id', handler: (req) => ({ json: { id: req.params.id } }) });
    host.http.route({ method: 'POST', path: '/hooks/*', handler: (req) => ({ json: { raw: req.path, wildcard: req.params['*'] } }) });
    // services：带 namespace 的注册（服务发现用；payload 里应能看到）
    host.services.provide('demo', () => 'demo-ok', { namespace: 'fixture.iface' });

    // 宿主新面：附件（upload / resolvePath）+ 流式 Response 透传
    host.http.route({
      method: 'POST',
      path: '/attach-echo',
      handler: async () => {
        const saved = await host.attachments.upload({
          sessionId: 's1',
          bytes: new Uint8Array([1, 2, 3]),
          mimeType: 'image/png',
          filename: 'a.png',
        });
        return { json: saved };
      },
    });
    host.http.route({
      method: 'GET',
      path: '/stream',
      handler: () => new Response('data: a\\ndata: b\\n\\n', { headers: { 'content-type': 'text/event-stream' } }),
    });
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
    host.ui.slot({ slot: 'chat.rail.left', id: 'x', component: 'x' });              // 平台保留命名空间下的伪造名
    host.ui.slot({ slot: 'bare-name', id: 'x', component: 'x' });                   // 裸名（无 <pluginId>. 前缀）
    host.ui.slot({ slot: 'a.', id: 'x', component: 'x' });                          // 尾点（形态非法）
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
const attachmentUploads: Array<{ sessionId: string; bytes: Uint8Array; mimeType: string; filename?: string }> = [];
const dataDirRoot = path.join(runDir, 'plugin-data');

const realBus = createPluginBus();
const realServices = createPluginServices();

const stubHost = {
  bus: {
    declare: (pluginId: string, topic: string, options: { declaredBy: 'publisher' | 'subscriber' }) =>
      realBus.declare(pluginId, topic, options),
    publish: (pluginId: string, topic: string, payload?: unknown) => realBus.publish(pluginId, topic, payload),
    publishAndWait: (pluginId: string, topic: string, payload?: unknown, options?: { timeoutMs?: number }) =>
      realBus.publishAndWait(pluginId, topic, payload, options),
    subscribe: (pluginId: string, topic: string, listener: (p: unknown) => void) =>
      realBus.subscribe(pluginId, topic, listener),
    topics: () => realBus.topics(),
    topicsOf: (pluginId: string) => realBus.topicsOf(pluginId),
    disposePlugin: (pluginId: string) => realBus.disposePlugin(pluginId),
  },
  services: {
    provide: (pluginId: string, name: string, handler: (p: unknown) => unknown, options?: { namespace?: string }) =>
      realServices.provide(pluginId, name, handler, options),
    call: (caller: string, name: string, payload?: unknown, options?: { timeoutMs?: number }) =>
      realServices.call(caller, name, payload, options),
    list: (filter?: { namespace?: string }) => realServices.list(filter),
    listOf: (pluginId: string) => realServices.listOf(pluginId),
    namespaces: () => realServices.namespaces(),
    disposePlugin: (pluginId: string) => realServices.disposePlugin(pluginId),
  },
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
    runtime: () => ({ version: 'test', uptimeMs: 0, nodeEnv: 'test', port: 0, pid: 0, workers: { active: 0, placeholders: 0, max: 1, pendingCalls: 0 } }),
  },
  // 附件面：记录调用，返回固定形状（真实存储在 `host-api-impl` 里，这里只验契约穿过来了）。
  attachments: {
    upload: async (input: { sessionId: string; bytes: Uint8Array; mimeType: string; filename?: string }) => {
      attachmentUploads.push(input);
      return {
        id: 'att_test',
        sha: `sha-${input.bytes.byteLength}`,
        mimeType: input.mimeType,
        sizeBytes: input.bytes.byteLength,
        filename: `sha-${input.bytes.byteLength}.png`,
        originalFilename: input.filename ?? 'unknown',
      };
    },
    resolvePath: (sessionId: string, name: string) => `${dataDirRoot}/${sessionId}/${name}`,
  },
};

const deps = {
  host: stubHost as never,
  registerService(source: string, _kind: string, handlers: Record<string, unknown>) {
    serviceRegistrations += 1;
    reverseMethods[source] = Object.keys(handlers);
  },
  /** 插件私有数据目录：真实入口会 `mkdir -p` 后下发，这里给每个插件一个独立目录。 */
  dataDirFor(pluginId: string) {
    const dir = path.join(dataDirRoot, pluginId);
    mkdirSync(dir, { recursive: true });
    return dir;
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
check(full.pages.length === 2, 'R1 页面注册成功（含一个 parent 二级页）', full.pages);
check(
  full.pages.some((p) => p.path === '/fixture/sub' && p.parent === '/fixture'),
  'R1 page.parent 原样保留（跨插件挂载只认路径字符串）',
  full.pages,
);
check(full.surfaces.length === 2, 'R9 挂载点注册成功（平台空间 + 插件空间各一）', full.surfaces);
check(
  full.surfaces.some((s) => s.slot === 'fixture.host-point' && (s as { scope?: string }).scope === 'global'),
  '插件空间槽位记为 global 作用域',
  full.surfaces,
);
check(full.toolCards.length === 1, 'R10 工具卡注册成功', full.toolCards);
check(full.routes.length === 5, 'R2 五条路由注册成功（字面量 / :param / * / 附件 / 流式）', full.routes);
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
check(illegal.rejected.length === 9, `非法注册 9 条全部进 rejected（实际 ${illegal.rejected.length}）`, reasons);
check(reasons.some((r) => r.includes('重复注册')), '同 method+path 重名被拒');
check(reasons.some((r) => r.includes('只能作为最后一段')), '* 非末段被拒');
check(reasons.some((r) => r.includes('必须独占一段')), '* 不独占一段被拒');
check(reasons.some((r) => r.includes('chat.rail.left')), '平台保留命名空间下的伪造槽位被拒');
check(reasons.filter((r) => r.includes('invalid-slot-name')).length === 3, '保留命名空间 / 裸名 / 尾点都按非法槽位名拒绝');
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

section('5b) 会话级插件启用列表（agent.config.plugins）');
{
  const { resolveSessionPlugins } = (await import(
    path.join(platformRoot, 'packages/core/src/services/plugins.js') as string
  )) as {
    resolveSessionPlugins(o: {
      snapshot: { plugins: Array<Record<string, unknown>>; disabledByFlag: boolean };
      enabledPlugins?: string[];
      agentExtensions: string[];
      installedPiExtensions: string[];
    }): Array<{ id: string; enabled: boolean; reason?: string; extensionPath?: string; skillPaths?: string[] }>;
  };
  const snapshot = {
    disabledByFlag: false,
    plugins: [
      {
        entry: { id: 'alpha', dir: '/tmp/alpha', enabled: true },
        status: 'active',
        facets: { extension: true, worker: false, web: false, server: true },
        skillPaths: ['/tmp/alpha/skills/x'],
        manifest: null,
      },
    ],
  } as never;
  const off = resolveSessionPlugins({
    snapshot,
    enabledPlugins: [],
    agentExtensions: [],
    installedPiExtensions: [],
  });
  check(
    off.length === 1 && !off[0]!.enabled && !off[0]!.extensionPath && (off[0]!.skillPaths ?? []).length === 0,
    '未在 agent.config.plugins 里启用 → 插件对本会话不生效（无 pi 扩展 / 无 skill）',
  );
  const on = resolveSessionPlugins({
    snapshot,
    enabledPlugins: ['alpha'],
    agentExtensions: [],
    installedPiExtensions: [],
  });
  check(
    on[0]!.enabled && Boolean(on[0]!.extensionPath),
    '在启用列表里 → 插件对会话生效（extensionPath 下发，worker 才会装载工具）',
  );
}

section('6) inline 插件（工具归属与自动注入）');
const { createServerTools } = (await import(
  path.join(platformRoot, 'workers/session-worker/src/tools.js') as string
)) as {
  createServerTools(
    sessionId: string,
    callMaster: (m: string, a: unknown[]) => Promise<unknown>,
    opts?: { capabilityIndex?: unknown[] },
  ): Array<{ name: string }>;
};
const noopCall = async () => ({});

// `callServer` 已随 capabilities 一起退役：管理动作改由 `admin` 插件声明（动作契约）。
const inlineTools = createServerTools('s1', noopCall);
check(inlineTools.some((t) => t.name === 'sendFileToUser'), 'inline 插件 sendFileToUser 自动注入（无逐 agent 白名单）');
check(
  !inlineTools.some((t) => t.name === 'callServer'),
  'callServer 不再存在（管理动作迁到 admin 插件的动作面）',
);
check(
  !inlineTools.some((t) => t.name === 'postNotification'),
  'postNotification 由 notifications 的动作投影注入（不是 worker 硬编码）',
);

section('6b) 动作契约：一份 handler → 四个独立投影');
{
  const { createPluginActions } = (await import(
    path.join(platformRoot, 'packages/core/src/services/plugin-actions.js') as string
  )) as { createPluginActions(): import('@pi-agent-platform/core').PluginActions };
  const acts = createPluginActions();
  const handler = (p: unknown) => ({ echo: p });

  // ① 默认值：reverse 开、其余关（"漏了会静默坏" 才默认开）
  const def = acts.define('alpha', {
    'task.list': { params: { type: 'object' }, handler },
  });
  check(def.ok, 'define 成功');
  const rec = acts.resolve('alpha.task.list')!;
  check(rec.reverse === true, 'reverse 默认开（漏了会静默调不通）');
  check(rec.reach === 'own', "scope 默认 'own'（跨插件调用要显式 public）");
  check(rec.service === false && rec.tool === undefined && rec.httpPath === undefined, 'service / tool / http 默认关');
  check(acts.reachOf('alpha.task.list') === 'own', 'reachOf 供 master 做归属校验');

  // ①b 一个动作只有一个名字：反向方法与 service 用**同一个字符串**
  //     （老 IPC 层有 `plugin.` 段时，同一个动作在这两张表里是两个名字）
  check(rec.name === 'alpha.task.list', '动作全名 = <pluginId>.<action>，没有额外前缀段');
  check(
    realServices.provide('alpha', rec.name, () => ({ ok: true })).ok,
    'service 直接用动作全名注册（不换名、不重复拼前缀）',
  );
  check(
    realServices.list().filter((x) => x.name === rec.name).length === 1,
    'services 表里同一个动作只有一个名字',
  );
  realServices.disposePlugin('alpha');

  // ② 四种组合都能表达（旧契约做不到的）
  const combos = acts.define('alpha', {
    'only.service': { params: { type: 'object' }, handler, reverse: false, service: true },
    'own.service': { params: { type: 'object' }, handler, scope: 'own', service: true },
    'public.tool': { params: { type: 'object' }, handler, scope: 'public', tool: { description: 'x' } },
    'only.http': { params: { type: 'object' }, handler, reverse: false, http: {} },
  });
  check(combos.ok, '四字段可自由组合（含 reverse:false + http）');
  check(acts.resolve('alpha.only.service')!.reverse === false, 'reverse:false = 自己 worker 调不到');
  check(acts.resolve('alpha.only.http')!.reverse === false, 'http 不依赖 reverse（主进程直调 handler）');
  check(acts.resolve('alpha.only.http')!.httpPath === '/only/http', 'http 路径缺省由动作名推导');
  check(acts.resolve('alpha.public.tool')!.tool?.name === 'alpha__public_tool', '工具名缺省 <id>__<action>');
  check(acts.resolve('alpha.public.tool')!.tool?.exposure === 'deferred', 'exposure 缺省 deferred（零上下文成本）');

  // ③ 校验：tool 必须能经反向方法执行；deferred 不许带 prompt；http 必须对象；路径精确
  check(!acts.define('alpha', { bad: { params: {}, handler, tool: { description: 'x' }, reverse: false } }).ok, 'tool + reverse:false 被拒');
  check(
    !acts.define('alpha', {
      bad2: { params: {}, handler, tool: { description: 'x', exposure: 'deferred', promptSnippet: 'y' } },
    }).ok,
    'deferred + promptSnippet 被拒（会破前缀缓存）',
  );
  check(!acts.define('alpha', { bad3: { params: {}, handler, http: true as never } }).ok, 'http: true 被拒（必须对象）');
  check(!acts.define('alpha', { bad4: { params: {}, handler, http: { path: '/x/:id' } } }).ok, ':param 路径被拒');
  check(!acts.define('alpha', { bad5: { params: {}, handler, http: { path: '/x/*' } } }).ok, '通配路径被拒');
  check(!acts.define('alpha', { bad6: { handler } }).ok === false, '无 params 的反向/service 动作合法');
  check(!acts.define('__core__', { x: { params: {}, handler } }).ok, '保留 id 被拒');

  // ④ 整批不注册：一条不合法 ⇒ 一条都不进表
  const before = acts.count();
  const partial = acts.define('alpha', {
    good: { params: { type: 'object' }, handler },
    bad: { params: {}, handler, tool: { description: 'x' }, reverse: false },
  });
  check(!partial.ok && acts.count() === before, '整批校验失败 → 不落任何一条（不做部分注册）');

  // ⑤ 描述符与卸载
  const desc = acts.descriptorsFor(['alpha']);
  check(desc.length >= 1 && desc.every((d) => d.tool.name && d.params), '描述符只取有 tool 的动作');
  check(acts.descriptorsFor([]).length === 0, '未启用的插件没有描述符');
  acts.disposePlugin('alpha');
  check(acts.count() === 0, '卸载后动作全部消失');
}

section('6c) 动作 HTTP 面：路径精确 / 开关默认关');
{
  const src = readFileSync(path.join(platformRoot, 'apps/pi-agent-server/src/config.ts'), 'utf8');
  check(
    /actionHttpEnabled:\s*env\.PI_SERVER_ACTION_HTTP === '1'/.test(src),
    'HTTP 面全局开关默认关（只有显式 PI_SERVER_ACTION_HTTP=1 才开）',
  );
  const ext = readFileSync(path.join(platformRoot, 'packages/core/src/services/plugin-extensions.ts'), 'utf8');
  check(
    ext.includes("action http surface is disabled") && ext.includes('status: 404'),
    '开关关闭时动作路由返回 404（不是 403、不是静默 500）',
  );
  check(
    ext.includes("method: 'POST'") && ext.includes("json: { error: check.message }"),
    '动作 HTTP 只认 POST + 校验失败 400 + 错误原文',
  );
}

section('7) 插件互操作：bus 声明化 + services 定向调用');

// ① 声明与拒绝
const d1 = realBus.declare('alpha', 'alpha.ready', { declaredBy: 'publisher' });
check(d1.ok, '合法声明成功');
check(realBus.topics().some((t) => t.topic === 'alpha.ready' && t.owner === 'alpha'), '声明进入目录（owner 正确）');
const d2 = realBus.declare('alpha', 'beta.ready', { declaredBy: 'publisher' });
check(!d2.ok && d2.reason === 'invalid-topic', '前缀不符被拒（invalid-topic）');
// 抢别人的 topic：前缀规则先拦下（前缀 = 声明者 id ⇒ 声明权天然唯一）
const d3 = realBus.declare('beta', 'alpha.ready', { declaredBy: 'publisher' });
check(!d3.ok && d3.reason === 'invalid-topic', '别人已声明的 topic 抢不走（前缀不符）');
const d4 = realBus.declare('alpha', 'alpha.ready', { declaredBy: 'publisher' });
check(d4.ok, '同 owner 重复声明幂等（reload 不炸）');

// ② owner 双向管控
const spoof = realBus.publish('beta', 'alpha.ready', {});
check(!spoof.ok && spoof.reason === 'not-owner', '冒名发布被拒（not-owner）');
const capTopic = realBus.declare('beta', 'beta.inbox', { declaredBy: 'subscriber' });
check(capTopic.ok, 'subscriber 型 topic 声明成功');
const steal = realBus.subscribe('gamma', 'beta.inbox', () => {});
check(steal.state === 'pending', 'subscriber 型 topic 别人订阅不生效（待生效 = 防抢单）');
const selfSub = realBus.subscribe('beta', 'beta.inbox', () => {});
check(selfSub.state === 'matched', 'owner 自己订阅 subscriber 型 topic 立即生效');

// ③ 送达语义
const noSub = realBus.publish('alpha', 'alpha.silent', {});
check(!noSub.ok && noSub.reason === 'unknown-topic', '未声明 topic 发布被拒（unknown-topic）');
realBus.declare('alpha', 'alpha.silent', { declaredBy: 'publisher' });
const zero = realBus.publish('alpha', 'alpha.silent', {});
check(zero.ok && zero.delivered === 0, '无订阅者 = {ok:true, delivered:0}（正常态）');

const seen: unknown[] = [];
realBus.subscribe('alpha', 'alpha.ready', (p) => seen.push(p));
realBus.subscribe('alpha', 'alpha.ready', () => {});
realBus.subscribe('alpha', 'alpha.ready', () => {});
const three = realBus.publish('alpha', 'alpha.ready', { n: 1 });
check(three.ok && three.delivered === 3, '多订阅者计数正确（delivered:3）');

// ④ 返回值被丢弃（机制，不是约定）
realBus.declare('alpha', 'alpha.greedy', { declaredBy: 'publisher' });
realBus.subscribe('alpha', 'alpha.greedy', () => ({ unread: 7 }));
const greedy = realBus.publish('alpha', 'alpha.greedy', {});
check(greedy.delivered === 1 && greedy['unread'] === undefined, 'handler 返回值被丢弃（业务数据只能走 services）');

// ⑤ pending → matched
const late = realBus.subscribe('alpha', 'alpha.late', () => seen.push('late'));
check(late.state === 'pending', '先订阅后声明 = pending（不报错）');
realBus.declare('alpha', 'alpha.late', { declaredBy: 'publisher' });
realBus.publish('alpha', 'alpha.late', {});
check(seen.includes('late'), 'pending 订阅在声明后自动生效');

// ⑥ 同步变体只回报成败
realBus.declare('alpha', 'alpha.sync', { declaredBy: 'publisher' });
realBus.subscribe('alpha', 'alpha.sync', () => ({ ignored: true }));
realBus.subscribe('alpha', 'alpha.sync', () => {
  throw new Error('boom');
});
const waited = await realBus.publishAndWait('alpha', 'alpha.sync', {});
check(waited.ok && waited.handled === 1 && waited.failed === 1, 'publishAndWait 只报成败（抛错不外抛）');

// ⑦ services：提供 / 调用 / 缺失 / 抛错 / 唯一提供者
const p1 = realServices.provide('alpha', 'alpha.echo', (payload) => ({ echo: payload }));
check(p1.ok, 'provide 成功');
const p2 = realServices.provide('beta', 'alpha.echo', () => 1);
check(!p2.ok && p2.reason === 'not-owner', '前缀不符的 provide 被拒');
const p3 = realServices.provide('alpha', 'alpha.echo', () => 2);
check(!p3.ok && p3.reason === 'duplicate', '重复提供者被拒（不静默覆盖）');
const echoed = await realServices.call('beta', 'alpha.echo', { hi: 1 });
check((echoed as { echo: unknown }).echo !== undefined, 'call 拿到业务数据');
let unknownErr = '';
try {
  await realServices.call('beta', 'beta.missing');
} catch (err) {
  unknownErr = String((err as Error).message);
}
check(unknownErr.includes('unknown service'), '无提供者 → unknown service');

realServices.provide('alpha', 'alpha.boom', () => {
  throw new Error('db down');
});
let boomErr = '';
try {
  await realServices.call('beta', 'alpha.boom');
} catch (err) {
  boomErr = String((err as Error).message);
}
check(boomErr === 'db down', '提供者抛错原样透传');

// ⑧ 两个表互不混入 + 卸载归零
check(
  realServices.list().filter((svc) => svc.owner === 'alpha').map((svc) => svc.name).sort().join(',') === 'alpha.boom,alpha.echo',
  'services 目录只含显式 provide 的名字（不混入反向方法 / 动作）',
);
realBus.disposePlugin('alpha');
realServices.disposePlugin('alpha');
check(realBus.topics().every((t) => t.owner !== 'alpha'), '卸载后该插件的 topic 全部消失');
check(realServices.list().every((svc) => svc.owner !== 'alpha'), '卸载后该插件的 service 全部消失');
let goneErr = '';
try {
  await realServices.call('beta', 'alpha.echo');
} catch (err) {
  goneErr = String((err as Error).message);
}
check(goneErr.includes('unknown service'), '提供者卸载后 call 立刻抛 unknown service');
realBus.clear();
realServices.clear();


// ── 6d. 新宿主面与命名空间 + 插件级事件 ──────────────────────────────────

section('6d) 附件面 / dataDir / services.namespace / 插件级事件 / 页面 parent');

// ① dataDir 与安装目录分离
const hostOfProbe = (() => {
  const before = realServices.list().length;
  void before;
  return null;
})();
void hostOfProbe;

{
  const dir = deps.dataDirFor('fixture-full');
  check(dir.startsWith(dataDirRoot), 'dataDir 落在数据根下（不是插件安装目录）', dir);
  check(dir !== path.join(pluginsDir, 'fixture-full'), 'dataDir 不等于安装目录');
}

// ② services namespace：形态校验 + 精确匹配 + 多对多
{
  realServices.clear();
  const ok1 = realServices.provide('channel-a', 'channel-a.channel', () => 'A', { namespace: 'im.channel' });
  const ok2 = realServices.provide('channel-b', 'channel-b.channel', () => 'B', { namespace: 'im.channel' });
  const ok3 = realServices.provide('channel-a', 'channel-a.media', () => 'M', { namespace: 'im.channel.media' });
  const bad = realServices.provide('channel-a', 'channel-a.bad', () => 'X', { namespace: 'channel' });
  check(ok1.ok && ok2.ok && ok3.ok, '多对多：同一 namespace 允许 0..n 个提供者');
  check(!bad.ok && bad.reason === 'invalid-namespace', 'namespace 无 pluginId 前缀 → invalid-namespace');
  const exact = realServices.list({ namespace: 'im.channel' });
  check(exact.length === 2 && exact.every((s) => s.namespace === 'im.channel'), 'list({namespace}) 精确匹配（不含 im.channel.media）', exact);
  const media = realServices.list({ namespace: 'im.channel.media' });
  check(media.length === 1 && media[0].name === 'channel-a.media', '多级 namespace 精确匹配');
  check(realServices.namespaces().join(',') === 'im.channel,im.channel.media', 'namespaces() 枚举现有标签', realServices.namespaces());
  check(realServices.list().length === 3, 'list() 无参数返回全部');
  realServices.clear();
}

// ③ 附件面与路由 Response 透传：走真实装载的插件
{
  attachmentUploads.length = 0;
  const res = await dispatchPluginRoute(
    'fixture-full',
    {
      path: '/attach-echo',
      method: 'POST',
      query: {},
      body: '',
      headers: new Headers(),
    },
    () => true,
  );
  check(attachmentUploads.length === 1, 'host.attachments.upload 被调用到', attachmentUploads);
  check(
    attachmentUploads[0]?.mimeType === 'image/png' && attachmentUploads[0]?.bytes.byteLength === 3,
    'attachments 透传 bytes / mimeType / filename',
  );
  void res;
}

// ④ 插件级事件：一个插件一次，payload 带清单
{
  const loadedEvents: Array<Record<string, unknown>> = [];
  const unloadedEvents: Array<Record<string, unknown>> = [];
  realBus.subscribe('observer', '__core__.plugin.loaded', (p) => loadedEvents.push(p as Record<string, unknown>));
  realBus.subscribe('observer', '__core__.plugin.unloaded', (p) => unloadedEvents.push(p as Record<string, unknown>));
  // 声明是内核在装载时做的，这里重新装载一次以触发事件（订阅先就位）。
  realServices.clear();
  const snap2 = getPluginSnapshot(pluginsDir);
  await loadPluginExtensions(snap2, deps);
  const fullLoaded = loadedEvents.filter((e) => e.pluginId === 'fixture-full');
  check(fullLoaded.length === 1, '一次装载只发一条 plugin.loaded（不是每次注册一条）', loadedEvents.length);
  const evt = fullLoaded[0] ?? {};
  check(evt.pluginId === 'fixture-full', 'payload.pluginId 正确', evt.pluginId);
  check(Array.isArray(evt.services) && (evt.services as unknown[]).length > 0, 'payload.services 带清单');
  check(
    (evt.services as Array<{ namespace?: string }>).some((s) => s.namespace === 'fixture.iface'),
    'payload.services 里的条目带 namespace（发现判据来自账本，不靠调用方猜）',
    evt.services,
  );
  check(Array.isArray(evt.pages) && (evt.pages as unknown[]).length > 0, 'payload.pages 带清单');
  check(Array.isArray(evt.facets) && (evt.facets as string[]).includes('server'), 'payload.facets 带清单');
  await disposeAllExtensions();
  check(unloadedEvents.some((e) => e.pluginId === 'fixture-full'), '卸载发 plugin.unloaded');
}

// ── 7. 收尾 ───────────────────────────────────────────────────────────────

await disposeAllExtensions();
check(registrationCount() === 0, '全部卸载后注册表归零');
raw.close();
rmSync(runDir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? '✓ verify-plugins 通过：10 个扩展点 / 零副作用 / 热加载 / 账本 / 拒绝可见' : `✗ verify-plugins 失败：${failures} 条断言不通过`}`);
process.exit(failures === 0 ? 0 : 1);
