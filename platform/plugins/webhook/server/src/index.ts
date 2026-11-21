/**
 * Webhook（bundled 插件）—— 外部系统 POST 事件 → agent 会话。
 *
 * 职责边界：**平台是哑端点**。收到的 body 原样作为 `<data>` 交给会话，
 * 过滤、解析、路由全在外部系统；`delivery.status` 只表示"消息有没有送进 agent"，
 * agent 干得怎么样不归这里管（与定时任务同一条口径）。
 *
 * 与定时任务（scheduler）的关系：**互不认识**。两者共享的只有内核能力
 * （`sessions.ensure` / `sessions.systemEvent`）与 `host.bus` 这个匿名交汇点；
 * 各自维护自己的表、自己的投递路径 —— 为此重复 ~60 行 dispatch 是刻意的取舍
 * （插件间依赖的代价更高）。
 *
 * URL：`POST /api/p/webhook/hooks/:id`。平台**不**加 `/hooks/*` 这类内核级别名：
 * 插件不得抢占平台路径前缀，否则 `/api/p/<pluginId>/` 的隔离就失效了。
 */

import type { PluginRouteHandler, PluginRouteRequest, PluginServerHost } from '@pi-agent-platform/plugin-types';
import {
  createStore,
  DDL,
  generateSecret,
  IDEMPOTENCY_WINDOW_MS,
  MAX_BODY_BYTES,
  secretsMatch,
  type WebhookStore,
} from './store.js';
import type {
  BusyPolicy,
  CreateHookInput,
  DispatchResult,
  HookDTO,
  SessionMode,
  UpdateHookInput,
} from './types.js';

const HOOK_ID_PREFIX = 'hook_';

export default {
  init(host: PluginServerHost) {
    // ── R4：自己的表 ──
    // 事件主题：publisher 型 —— 只有本插件能发，任何插件可订阅（广播）。
    host.bus.declare('webhook.delivery.failed', { declaredBy: 'publisher' });

    host.db.migrate('webhook', DDL);
    const store = createStore(host.db);

    const stale = store.finalizeStaleDeliveries();
    if (stale > 0) host.log('warn', `收尾 ${stale} 条僵尸投递（进程崩溃残留）`);

    // ── 唯一实现：两个面（反向方法 / service）都委托这里，绝不复制校验 ──
    //
    // 差别只有身份来源：反向方法从调用方**会话**推 agentId（工具不该替别的 agent 建入口），
    // service 没有会话 → 要求显式传 agentId（跨插件调用属于管理动作，信任边界在装载侧）。
    const api = {
      async create(payload: unknown, callerAgentId?: string) {
        const body = (payload ?? {}) as CreateHookInput & { agentId?: string };
        const agentId = callerAgentId ?? body.agentId;
        if (!agentId) throw new Error('无法解析调用方 agent（缺少会话上下文，service 调用必须显式传 agentId）');
        const { hook } = await createHook(host, store, { ...body, agentId });
        return { hook, url: hookUrl(hook.id) };
      },
      async list(payload: unknown, callerAgentId?: string) {
        const p = (payload ?? {}) as { agentId?: string };
        const agentId = callerAgentId ?? p.agentId;
        return { items: store.list({ agentId, includeDisabled: true }) };
      },
      async update(payload: unknown) {
        const p = (payload ?? {}) as { hookId?: string } & UpdateHookInput;
        if (!p.hookId) throw new Error('hookId is required');
        const hook = await updateHook(host, store, p.hookId, p);
        return { hook, url: hookUrl(hook.id) };
      },
      async remove(payload: unknown, callerAgentId?: string) {
        const p = (payload ?? {}) as { hookId?: string };
        if (!p.hookId) throw new Error('hookId is required');
        const hook = store.get(p.hookId);
        if (!hook) throw new Error(`hook 不存在：${p.hookId}`);
        // 归属校验只在有调用方身份时成立（反向方法路径）。
        if (callerAgentId && hook.agentId !== callerAgentId) {
          throw new Error('不能删除其他 agent 的 webhook');
        }
        store.remove(p.hookId);
        return { ok: true };
      },
    };

    // ── R3：反向方法（extension facet 的 `manage_webhook` 工具经此调用；带会话上下文）──
    host.methods.handle('hook.create', async (params, ctx) => {
      const callerAgentId = await callerAgentIdOf(host, ctx?.sessionId);
      if (!callerAgentId) throw new Error('无法解析调用方 agent（缺少会话上下文）');
      return api.create(params, callerAgentId);
    });
    host.methods.handle('hook.list', async (params, ctx) => {
      const callerAgentId = await callerAgentIdOf(host, ctx?.sessionId);
      return api.list(params, callerAgentId);
    });
    host.methods.handle('hook.delete', async (params, ctx) => {
      const callerAgentId = await callerAgentIdOf(host, ctx?.sessionId);
      return api.remove(params, callerAgentId);
    });

    // ── services（跨插件，无会话上下文）：其他插件请调这些，不要直接读表 ──
    host.services.provide('hook.list', (payload) => api.list(payload));
    host.services.provide('hook.create', (payload) => api.create(payload));
    host.services.provide('hook.update', (payload) => api.update(payload));
    host.services.provide('hook.delete', (payload) => api.remove(payload));

    // ── R2：外部入口 ──
    //
    // 一个端点做三件事：鉴权 → 读 body（截断）→ 投递。
    // 任何一步失败都不该产生"半条"投递记录之外的副作用。
    host.http.route({
      method: 'POST',
      path: '/hooks/:id',
      handler: async (req) => {
        const hookId = req.params.id ?? '';
        const hook = store.get(hookId);
        // 未知 id：直接 404，不做"存在但鉴权失败"的区分（防枚举）。
        if (!hook) return { status: 404, json: { error: 'not found' } };

        const provided = bearerOf(req);
        if (!secretsMatch(hook.secret, provided)) {
          host.log('warn', `hook ${hookId} rejected: bad secret`);
          return { status: 401, json: { error: 'unauthorized' } };
        }

        const raw = req.body ?? '';
        const bytes = Buffer.byteLength(raw, 'utf-8');
        const { payload, truncated } = readPayload(raw, bytes);

        const result = await dispatch(host, store, hook, {
          triggeredBy: 'http',
          payload,
          payloadBytes: bytes,
          truncated,
          idempotencyKey: req.header('idempotency-key') ?? null,
          meta: {
            ...(req.header('x-forwarded-for') ? { ip: req.header('x-forwarded-for')! } : {}),
            ...(req.header('user-agent') ? { userAgent: req.header('user-agent')! } : {}),
          },
        });

        const extra = truncated ? { truncated: true, payloadBytes: bytes } : {};
        if (result.duplicate) return { status: 200, json: { status: 'duplicate', ...extra } };
        if (result.status === 'delivered') return { status: 202, json: { ...result, ...extra } };
        // skipped / failed 都是"收到了但没执行"
        return { status: 409, json: { ...result, ...extra } };
      },
    });

    // ── R2：管理端点 ──
    const route = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, handler: PluginRouteHandler): void => {
      host.http.route({ method, path, handler });
    };

    route('GET', '/hooks', (req) => ({
      json: {
        items: store.list({
          agentId: req.query.agentId,
          includeDisabled: req.query.includeDisabled === '1',
        }),
      },
    }));

    route('GET', '/hooks/:id', (req) => {
      const hook = store.get(req.params.id!);
      if (!hook) return { status: 404, json: { error: 'hook not found' } };
      return {
        json: { hook, url: hookUrl(hook.id), deliveries: store.listDeliveries(hook.id, 20) },
      };
    });

    route('POST', '/hooks', async (req) => {
      try {
        const { hook } = await createHook(host, store, parseBody(req.body) as CreateHookInput);
        return { status: 201, json: { hook, url: hookUrl(hook.id) } };
      } catch (err) {
        return { status: 400, json: { error: messageOf(err) } };
      }
    });

    const updateHandler: PluginRouteHandler = async (req) => {
      try {
        const hook = await updateHook(host, store, req.params.id!, parseBody(req.body) as UpdateHookInput);
        return { json: { hook, url: hookUrl(hook.id) } };
      } catch (err) {
        return { status: 400, json: { error: messageOf(err) } };
      }
    };
    // PUT 与 PATCH 同处理器：插件 web 面的 api 只有 get/post/put/del（没有 patch）。
    route('PATCH', '/hooks/:id', updateHandler);
    route('PUT', '/hooks/:id', updateHandler);

    route('DELETE', '/hooks/:id', (req) => {
      store.remove(req.params.id!);
      return { json: { ok: true } };
    });

    route('POST', '/hooks/:id/rotate-secret', (req) => {
      const hook = store.get(req.params.id!);
      if (!hook) return { status: 404, json: { error: 'hook not found' } };
      const secret = generateSecret();
      store.update(hook.id, { secret });
      return { json: { secret } };
    });

    route('GET', '/hooks/:id/deliveries', (req) => {
      const limit = Number(req.query.limit ?? 50) || 50;
      return { json: { items: store.listDeliveries(req.params.id!, limit) } };
    });

    // 手动试投：走与 HTTP 入口**完全相同**的投递路径（只有 triggeredBy 不同）。
    route('POST', '/hooks/:id/run', async (req) => {
      const hook = store.get(req.params.id!);
      if (!hook) return { status: 404, json: { error: 'hook not found' } };
      const body = parseBody(req.body) as { payload?: unknown };
      const result = await dispatch(host, store, hook, {
        triggeredBy: 'manual',
        payload: body.payload,
        payloadBytes: null,
      });
      const status = result.status === 'delivered' ? 202 : 409;
      return { status, json: result };
    });

    // 编辑器需要的元数据（插件 web 面只能打自己的前缀，不能直连平台 API）。
    route('GET', '/meta', async () => ({
      json: {
        agents: (await host.agents.list()).map((a) => ({ id: a.id, name: a.name })),
        maxBodyBytes: MAX_BODY_BYTES,
        idempotencyWindowMs: IDEMPOTENCY_WINDOW_MS,
        origin: '',
      },
    }));

    route('GET', '/sessions', async (req) => {
      const agentId = req.query.agentId;
      const items = (await host.sessions.list())
        .filter((s) => (agentId ? s.agentId === agentId : true))
        .map((s) => ({ id: s.id, agentId: s.agentId, status: s.status }));
      return { json: { items } };
    });

    // ── R1：页面 ──
    host.ui.page({ path: '/webhooks', label: 'Webhook', icon: 'webhook', component: 'list', order: 16 });
    host.ui.page({ path: '/webhooks/new', label: '新建 Webhook', icon: 'webhook', component: 'editor', nav: false });
    host.ui.page({ path: '/webhooks/:id', label: 'Webhook', icon: 'webhook', component: 'editor', nav: false });

    return () => {
      // 无 timer / 无外部订阅（失败上报是 publish，不持有资源）。
    };
  },
};

// ────────────────────────────── 投递 ──────────────────────────────

interface DispatchOptions {
  triggeredBy: 'http' | 'manual' | 'plugin';
  payload: unknown;
  payloadBytes: number | null;
  truncated?: boolean;
  idempotencyKey?: string | null;
  meta?: Record<string, string>;
}

/**
 * 一次投递的完整路径：幂等 → 启用 → 忙时守卫 → ensure → systemEvent → 台账。
 *
 * 顺序有讲究：**幂等判定在建投递行之前**（重复请求不该留下第二行），
 * **忙时守卫在 ensure 之后**（`reuse` 的会话必须先存在才能问状态）。
 */
async function dispatch(
  host: PluginServerHost,
  store: WebhookStore,
  hook: HookDTO,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  if (!hook.enabled) {
    const deliveryId = store.createDelivery({
      hookId: hook.id,
      status: 'skipped',
      triggeredBy: opts.triggeredBy,
      idempotencyKey: opts.idempotencyKey ?? null,
      payloadBytes: opts.payloadBytes,
      reason: 'disabled',
    });
    return { status: 'skipped', deliveryId, reason: 'disabled' };
  }

  // 幂等：同一 hook + 同一 key 在 24h 内已经**成功送出**过 → 直接返回，不建行。
  if (opts.idempotencyKey) {
    const since = Date.now() - IDEMPOTENCY_WINDOW_MS;
    if (store.hasRecentIdempotencyKey(hook.id, opts.idempotencyKey, since)) {
      host.log('info', `hook ${hook.id} duplicate: idempotency-key ${opts.idempotencyKey}`);
      return { status: 'delivered', duplicate: true };
    }
  }

  const deliveryId = store.createDelivery({
    hookId: hook.id,
    status: 'failed',
    triggeredBy: opts.triggeredBy,
    idempotencyKey: opts.idempotencyKey ?? null,
    payloadBytes: opts.payloadBytes,
    finished: false,
  });

  try {
    // ① 取会话。绑定的目标无效时 `ensure` 抛错 → failed（绝不静默写到别的会话）。
    const session = await host.sessions.ensure({
      agentId: hook.agentId,
      ...(hook.sessionMode === 'reuse' && hook.sessionId ? { sessionId: hook.sessionId } : {}),
      ...(hook.sessionMode === 'reuse' && !hook.sessionId ? { title: `[${hook.name}]` } : {}),
    });

    // ② 忙时策略：`skip` 在这里退出；`followUp` / `steer` 交给 pi 排队/插队。
    if (hook.busyPolicy === 'skip' && (await host.sessions.status(session.sessionId)) === 'running') {
      store.finishDelivery(deliveryId, { status: 'skipped', reason: 'busy', sessionId: session.sessionId });
      host.log('info', `hook ${hook.id} skipped: busy (session ${session.sessionId} running)`);
      return { status: 'skipped', deliveryId, sessionId: session.sessionId, reason: 'busy' };
    }

    // ③ 投递（信封文本由内核构造）。返回即"送到"，不等 agent 跑完。
    await host.sessions.systemEvent({
      sessionId: session.sessionId,
      kind: 'webhook',
      source: 'http',
      name: hook.name,
      run: deliveryId,
      instruction: hook.prompt,
      ...(opts.payload === undefined ? {} : { data: envelopeData(opts.payload, opts.meta) }),
      ...(hook.busyPolicy === 'skip' ? {} : { streamingBehavior: hook.busyPolicy }),
    });

    store.finishDelivery(deliveryId, { status: 'delivered', sessionId: session.sessionId });
    store.markDelivered(hook.id);
    // reuse 首次投递后回填绑定，此后固定复用同一个会话。
    if (hook.sessionMode === 'reuse' && !hook.sessionId) {
      store.update(hook.id, { session_id: session.sessionId });
    }

    host.log('info', `hook ${hook.id} delivered → session ${session.sessionId} (${opts.triggeredBy})`);
    return { status: 'delivered', deliveryId, sessionId: session.sessionId };
  } catch (err) {
    const reason = messageOf(err);
    store.finishDelivery(deliveryId, { status: 'failed', reason });
    host.log('warn', `hook ${hook.id} delivery failed: ${reason}`);
    // 事件总线：通知插件订阅后落一行收件箱；没装通知插件就只有投递台账可查。
    const published = host.bus.publish('webhook.delivery.failed', {
      hookId: hook.id,
      deliveryId,
      name: hook.name,
      agentId: hook.agentId,
      reason,
      actionUrl: `/webhooks/${hook.id}`,
    });
    if (published.delivered === 0) {
      host.log('debug', 'delivery failed but no notification subscriber (topic=webhook.delivery.failed)');
    }
    return { status: 'failed', deliveryId, reason };
  }
}

/**
 * `<data>` 的形状**恒定**：`{ payload }`（+ 可选的 `_meta`）。
 *
 * 为什么恒定而不是"有 header 才包一层"：body 形状随请求头变化是最糟的不确定性 ——
 * 同一个 hook 的两次调用会让模型看到两种 JSON。恒定的代价只是多一层 `.payload`。
 */
function envelopeData(payload: unknown, meta?: Record<string, string>): unknown {
  const out: Record<string, unknown> = { payload };
  if (meta && Object.keys(meta).length > 0) out._meta = meta;
  return out;
}

// ────────────────────────────── 校验 ──────────────────────────────

async function createHook(
  host: PluginServerHost,
  store: WebhookStore,
  input: CreateHookInput,
): Promise<{ hook: HookDTO }> {
  const agentId = input.agentId?.trim();
  if (!agentId) throw new Error('agentId 不能为空');
  if (!host.agents.get(agentId)) throw new Error(`agent 不存在：${agentId}`);
  const prompt = input.prompt?.trim();
  if (!prompt) throw new Error('prompt 不能为空（事件到达时要执行的指令）');

  const sessionMode: SessionMode = input.sessionMode === 'reuse' ? 'reuse' : 'new';
  const sessionId = await normalizeSessionBinding(host, agentId, sessionMode, input.sessionId);

  const hook = store.insert({
    agentId,
    name: input.name?.trim() || defaultName(prompt),
    prompt,
    sessionMode,
    sessionId,
    busyPolicy: normalizeBusyPolicy(input.busyPolicy),
    secret: generateSecret(),
    enabled: true,
  });
  host.log('info', `created hook ${hook.id} (${hook.sessionMode})`);
  return { hook };
}

async function updateHook(
  host: PluginServerHost,
  store: WebhookStore,
  hookId: string,
  input: UpdateHookInput,
): Promise<HookDTO> {
  const hook = store.get(hookId);
  if (!hook) throw new Error(`hook 不存在：${hookId}`);

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name.trim() || hook.name;
  if (input.prompt !== undefined) {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('prompt 不能为空');
    patch.prompt = prompt;
  }
  if (input.busyPolicy !== undefined) patch.busy_policy = normalizeBusyPolicy(input.busyPolicy);
  if (input.enabled !== undefined && input.enabled !== hook.enabled) patch.enabled = input.enabled ? 1 : 0;

  // 会话绑定：传值 = 换绑；空串 = 解绑（首次投递时创建）；切到 new = 自动清空。
  const nextMode: SessionMode = input.sessionMode ?? hook.sessionMode;
  if (input.sessionMode !== undefined || input.sessionId !== undefined) {
    patch.session_mode = nextMode;
    patch.session_id = await normalizeSessionBinding(host, hook.agentId, nextMode, input.sessionId, hook.sessionId);
  }

  store.update(hookId, patch);
  return store.get(hookId)!;
}

async function normalizeSessionBinding(
  host: PluginServerHost,
  agentId: string,
  mode: SessionMode,
  sessionId: string | undefined,
  current?: string | null,
): Promise<string | null> {
  if (mode === 'new') {
    // 不静默丢弃：传了就报错，否则"两个人对写哪儿有不同理解"。
    if (sessionId) throw new Error('sessionMode=new 时不能指定 sessionId');
    return null;
  }
  if (sessionId === undefined) return current ?? null;
  if (!sessionId) return null;
  const session = await host.sessions.get(sessionId);
  if (!session) throw new Error(`会话不存在：${sessionId}`);
  if (session.agentId && session.agentId !== agentId) throw new Error(`会话 ${sessionId} 不属于该 agent`);
  return sessionId;
}

function normalizeBusyPolicy(value: unknown): BusyPolicy {
  if (value === undefined || value === null || value === '') return 'followUp';
  if (value === 'followUp' || value === 'steer' || value === 'skip') return value;
  throw new Error(`busyPolicy 只能是 followUp / steer / skip，收到：${String(value)}`);
}

function defaultName(prompt: string): string {
  const head = prompt.trim().split(/[\n。.!?]/)[0]?.trim() ?? '';
  return head.length > 24 ? `${head.slice(0, 24)}…` : head || '外部事件';
}

// ────────────────────────────── 小工具 ──────────────────────────────

/**
 * 完整 URL 的**相对形式**：平台不知道自己的公网地址（反代/内网/端口都可能不同），
 * 页面用 `location.origin` 补全，工具直接把路径给出去。
 */
export function hookUrl(hookId: string): string {
  return `/api/p/webhook/hooks/${hookId}`;
}

function bearerOf(req: PluginRouteRequest): string {
  const header = req.header('authorization') ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

/** 解析 body：> 64 KiB 先截断；能 JSON 就 JSON，否则原文。 */
function readPayload(raw: string, bytes: number): { payload: unknown; truncated: boolean } {
  if (bytes > MAX_BODY_BYTES) {
    const cut = Buffer.from(raw, 'utf-8').subarray(0, MAX_BODY_BYTES).toString('utf-8');
    return {
      payload: safeParse(cut) ?? { truncated: true, note: `body exceeded ${MAX_BODY_BYTES} bytes and was truncated` },
      truncated: true,
    };
  }
  if (raw.length === 0) return { payload: undefined, truncated: false };
  return { payload: safeParse(raw) ?? raw, truncated: false };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseBody(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('body 不是合法 JSON');
  }
}

async function callerAgentIdOf(host: PluginServerHost, sessionId?: string): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const session = await host.sessions.get(sessionId);
  return session?.agentId;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
