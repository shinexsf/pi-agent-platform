import {
  createStore,
  DDL,
  generateSecret,
  IDEMPOTENCY_WINDOW_MS,
  MAX_BODY_BYTES,
  secretsMatch
} from "./store.js";
const HOOK_ID_PREFIX = "hook_";
var src_default = {
  init(host) {
    host.bus.declare("webhook.delivery.failed", { declaredBy: "publisher" });
    host.db.migrate("webhook", DDL);
    const store = createStore(host.db);
    const stale = store.finalizeStaleDeliveries();
    if (stale > 0) host.log("warn", `\u6536\u5C3E ${stale} \u6761\u50F5\u5C38\u6295\u9012\uFF08\u8FDB\u7A0B\u5D29\u6E83\u6B8B\u7559\uFF09`);
    const api = {
      async create(payload, callerAgentId) {
        const body = payload ?? {};
        const agentId = callerAgentId ?? body.agentId;
        if (!agentId) throw new Error("\u65E0\u6CD5\u89E3\u6790\u8C03\u7528\u65B9 agent\uFF08\u7F3A\u5C11\u4F1A\u8BDD\u4E0A\u4E0B\u6587\uFF0Cservice \u8C03\u7528\u5FC5\u987B\u663E\u5F0F\u4F20 agentId\uFF09");
        const { hook } = await createHook(host, store, { ...body, agentId });
        return { hook, url: hookUrl(hook.id) };
      },
      async list(payload, callerAgentId) {
        const p = payload ?? {};
        const agentId = callerAgentId ?? p.agentId;
        return { items: store.list({ agentId, includeDisabled: true }) };
      },
      async update(payload) {
        const p = payload ?? {};
        if (!p.hookId) throw new Error("hookId is required");
        const hook = await updateHook(host, store, p.hookId, p);
        return { hook, url: hookUrl(hook.id) };
      },
      async remove(payload, callerAgentId) {
        const p = payload ?? {};
        if (!p.hookId) throw new Error("hookId is required");
        const hook = store.get(p.hookId);
        if (!hook) throw new Error(`hook \u4E0D\u5B58\u5728\uFF1A${p.hookId}`);
        if (callerAgentId && hook.agentId !== callerAgentId) {
          throw new Error("\u4E0D\u80FD\u5220\u9664\u5176\u4ED6 agent \u7684 webhook");
        }
        store.remove(p.hookId);
        return { ok: true };
      }
    };
    host.methods.handle("hook.create", async (params, ctx) => {
      const callerAgentId = await callerAgentIdOf(host, ctx?.sessionId);
      if (!callerAgentId) throw new Error("\u65E0\u6CD5\u89E3\u6790\u8C03\u7528\u65B9 agent\uFF08\u7F3A\u5C11\u4F1A\u8BDD\u4E0A\u4E0B\u6587\uFF09");
      return api.create(params, callerAgentId);
    });
    host.methods.handle("hook.list", async (params, ctx) => {
      const callerAgentId = await callerAgentIdOf(host, ctx?.sessionId);
      return api.list(params, callerAgentId);
    });
    host.methods.handle("hook.delete", async (params, ctx) => {
      const callerAgentId = await callerAgentIdOf(host, ctx?.sessionId);
      return api.remove(params, callerAgentId);
    });
    host.services.provide("hook.list", (payload) => api.list(payload));
    host.services.provide("hook.create", (payload) => api.create(payload));
    host.services.provide("hook.update", (payload) => api.update(payload));
    host.services.provide("hook.delete", (payload) => api.remove(payload));
    host.http.route({
      method: "POST",
      path: "/hooks/:id",
      handler: async (req) => {
        const hookId = req.params.id ?? "";
        const hook = store.get(hookId);
        if (!hook) return { status: 404, json: { error: "not found" } };
        const provided = bearerOf(req);
        if (!secretsMatch(hook.secret, provided)) {
          host.log("warn", `hook ${hookId} rejected: bad secret`);
          return { status: 401, json: { error: "unauthorized" } };
        }
        const raw = req.body ?? "";
        const bytes = Buffer.byteLength(raw, "utf-8");
        const { payload, truncated } = readPayload(raw, bytes);
        const result = await dispatch(host, store, hook, {
          triggeredBy: "http",
          payload,
          payloadBytes: bytes,
          truncated,
          idempotencyKey: req.header("idempotency-key") ?? null,
          meta: {
            ...req.header("x-forwarded-for") ? { ip: req.header("x-forwarded-for") } : {},
            ...req.header("user-agent") ? { userAgent: req.header("user-agent") } : {}
          }
        });
        const extra = truncated ? { truncated: true, payloadBytes: bytes } : {};
        if (result.duplicate) return { status: 200, json: { status: "duplicate", ...extra } };
        if (result.status === "delivered") return { status: 202, json: { ...result, ...extra } };
        return { status: 409, json: { ...result, ...extra } };
      }
    });
    const route = (method, path, handler) => {
      host.http.route({ method, path, handler });
    };
    route("GET", "/hooks", (req) => ({
      json: {
        items: store.list({
          agentId: req.query.agentId,
          includeDisabled: req.query.includeDisabled === "1"
        })
      }
    }));
    route("GET", "/hooks/:id", (req) => {
      const hook = store.get(req.params.id);
      if (!hook) return { status: 404, json: { error: "hook not found" } };
      return {
        json: { hook, url: hookUrl(hook.id), deliveries: store.listDeliveries(hook.id, 20) }
      };
    });
    route("POST", "/hooks", async (req) => {
      try {
        const { hook } = await createHook(host, store, parseBody(req.body));
        return { status: 201, json: { hook, url: hookUrl(hook.id) } };
      } catch (err) {
        return { status: 400, json: { error: messageOf(err) } };
      }
    });
    const updateHandler = async (req) => {
      try {
        const hook = await updateHook(host, store, req.params.id, parseBody(req.body));
        return { json: { hook, url: hookUrl(hook.id) } };
      } catch (err) {
        return { status: 400, json: { error: messageOf(err) } };
      }
    };
    route("PATCH", "/hooks/:id", updateHandler);
    route("PUT", "/hooks/:id", updateHandler);
    route("DELETE", "/hooks/:id", (req) => {
      store.remove(req.params.id);
      return { json: { ok: true } };
    });
    route("POST", "/hooks/:id/rotate-secret", (req) => {
      const hook = store.get(req.params.id);
      if (!hook) return { status: 404, json: { error: "hook not found" } };
      const secret = generateSecret();
      store.update(hook.id, { secret });
      return { json: { secret } };
    });
    route("GET", "/hooks/:id/deliveries", (req) => {
      const limit = Number(req.query.limit ?? 50) || 50;
      return { json: { items: store.listDeliveries(req.params.id, limit) } };
    });
    route("POST", "/hooks/:id/run", async (req) => {
      const hook = store.get(req.params.id);
      if (!hook) return { status: 404, json: { error: "hook not found" } };
      const body = parseBody(req.body);
      const result = await dispatch(host, store, hook, {
        triggeredBy: "manual",
        payload: body.payload,
        payloadBytes: null
      });
      const status = result.status === "delivered" ? 202 : 409;
      return { status, json: result };
    });
    route("GET", "/meta", async () => ({
      json: {
        agents: (await host.agents.list()).map((a) => ({ id: a.id, name: a.name })),
        maxBodyBytes: MAX_BODY_BYTES,
        idempotencyWindowMs: IDEMPOTENCY_WINDOW_MS,
        origin: ""
      }
    }));
    route("GET", "/sessions", async (req) => {
      const agentId = req.query.agentId;
      const items = (await host.sessions.list()).filter((s) => agentId ? s.agentId === agentId : true).map((s) => ({ id: s.id, agentId: s.agentId, status: s.status }));
      return { json: { items } };
    });
    host.ui.page({ path: "/webhooks", label: "Webhook", icon: "webhook", component: "list", order: 16 });
    host.ui.page({ path: "/webhooks/new", label: "\u65B0\u5EFA Webhook", icon: "webhook", component: "editor", nav: false });
    host.ui.page({ path: "/webhooks/:id", label: "Webhook", icon: "webhook", component: "editor", nav: false });
    return () => {
    };
  }
};
async function dispatch(host, store, hook, opts) {
  if (!hook.enabled) {
    const deliveryId2 = store.createDelivery({
      hookId: hook.id,
      status: "skipped",
      triggeredBy: opts.triggeredBy,
      idempotencyKey: opts.idempotencyKey ?? null,
      payloadBytes: opts.payloadBytes,
      reason: "disabled"
    });
    return { status: "skipped", deliveryId: deliveryId2, reason: "disabled" };
  }
  if (opts.idempotencyKey) {
    const since = Date.now() - IDEMPOTENCY_WINDOW_MS;
    if (store.hasRecentIdempotencyKey(hook.id, opts.idempotencyKey, since)) {
      host.log("info", `hook ${hook.id} duplicate: idempotency-key ${opts.idempotencyKey}`);
      return { status: "delivered", duplicate: true };
    }
  }
  const deliveryId = store.createDelivery({
    hookId: hook.id,
    status: "failed",
    triggeredBy: opts.triggeredBy,
    idempotencyKey: opts.idempotencyKey ?? null,
    payloadBytes: opts.payloadBytes,
    finished: false
  });
  try {
    const session = await host.sessions.ensure({
      agentId: hook.agentId,
      ...hook.sessionMode === "reuse" && hook.sessionId ? { sessionId: hook.sessionId } : {},
      ...hook.sessionMode === "reuse" && !hook.sessionId ? { title: `[${hook.name}]` } : {}
    });
    if (hook.busyPolicy === "skip" && await host.sessions.status(session.sessionId) === "running") {
      store.finishDelivery(deliveryId, { status: "skipped", reason: "busy", sessionId: session.sessionId });
      host.log("info", `hook ${hook.id} skipped: busy (session ${session.sessionId} running)`);
      return { status: "skipped", deliveryId, sessionId: session.sessionId, reason: "busy" };
    }
    await host.sessions.systemEvent({
      sessionId: session.sessionId,
      kind: "webhook",
      source: "http",
      name: hook.name,
      run: deliveryId,
      instruction: hook.prompt,
      ...opts.payload === void 0 ? {} : { data: envelopeData(opts.payload, opts.meta) },
      ...hook.busyPolicy === "skip" ? {} : { streamingBehavior: hook.busyPolicy }
    });
    store.finishDelivery(deliveryId, { status: "delivered", sessionId: session.sessionId });
    store.markDelivered(hook.id);
    if (hook.sessionMode === "reuse" && !hook.sessionId) {
      store.update(hook.id, { session_id: session.sessionId });
    }
    host.log("info", `hook ${hook.id} delivered \u2192 session ${session.sessionId} (${opts.triggeredBy})`);
    return { status: "delivered", deliveryId, sessionId: session.sessionId };
  } catch (err) {
    const reason = messageOf(err);
    store.finishDelivery(deliveryId, { status: "failed", reason });
    host.log("warn", `hook ${hook.id} delivery failed: ${reason}`);
    const published = host.bus.publish("webhook.delivery.failed", {
      hookId: hook.id,
      deliveryId,
      name: hook.name,
      agentId: hook.agentId,
      reason,
      actionUrl: `/webhooks/${hook.id}`
    });
    if (published.delivered === 0) {
      host.log("debug", "delivery failed but no notification subscriber (topic=webhook.delivery.failed)");
    }
    return { status: "failed", deliveryId, reason };
  }
}
function envelopeData(payload, meta) {
  const out = { payload };
  if (meta && Object.keys(meta).length > 0) out._meta = meta;
  return out;
}
async function createHook(host, store, input) {
  const agentId = input.agentId?.trim();
  if (!agentId) throw new Error("agentId \u4E0D\u80FD\u4E3A\u7A7A");
  if (!host.agents.get(agentId)) throw new Error(`agent \u4E0D\u5B58\u5728\uFF1A${agentId}`);
  const prompt = input.prompt?.trim();
  if (!prompt) throw new Error("prompt \u4E0D\u80FD\u4E3A\u7A7A\uFF08\u4E8B\u4EF6\u5230\u8FBE\u65F6\u8981\u6267\u884C\u7684\u6307\u4EE4\uFF09");
  const sessionMode = input.sessionMode === "reuse" ? "reuse" : "new";
  const sessionId = await normalizeSessionBinding(host, agentId, sessionMode, input.sessionId);
  const hook = store.insert({
    agentId,
    name: input.name?.trim() || defaultName(prompt),
    prompt,
    sessionMode,
    sessionId,
    busyPolicy: normalizeBusyPolicy(input.busyPolicy),
    secret: generateSecret(),
    enabled: true
  });
  host.log("info", `created hook ${hook.id} (${hook.sessionMode})`);
  return { hook };
}
async function updateHook(host, store, hookId, input) {
  const hook = store.get(hookId);
  if (!hook) throw new Error(`hook \u4E0D\u5B58\u5728\uFF1A${hookId}`);
  const patch = {};
  if (input.name !== void 0) patch.name = input.name.trim() || hook.name;
  if (input.prompt !== void 0) {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("prompt \u4E0D\u80FD\u4E3A\u7A7A");
    patch.prompt = prompt;
  }
  if (input.busyPolicy !== void 0) patch.busy_policy = normalizeBusyPolicy(input.busyPolicy);
  if (input.enabled !== void 0 && input.enabled !== hook.enabled) patch.enabled = input.enabled ? 1 : 0;
  const nextMode = input.sessionMode ?? hook.sessionMode;
  if (input.sessionMode !== void 0 || input.sessionId !== void 0) {
    patch.session_mode = nextMode;
    patch.session_id = await normalizeSessionBinding(host, hook.agentId, nextMode, input.sessionId, hook.sessionId);
  }
  store.update(hookId, patch);
  return store.get(hookId);
}
async function normalizeSessionBinding(host, agentId, mode, sessionId, current) {
  if (mode === "new") {
    if (sessionId) throw new Error("sessionMode=new \u65F6\u4E0D\u80FD\u6307\u5B9A sessionId");
    return null;
  }
  if (sessionId === void 0) return current ?? null;
  if (!sessionId) return null;
  const session = await host.sessions.get(sessionId);
  if (!session) throw new Error(`\u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF1A${sessionId}`);
  if (session.agentId && session.agentId !== agentId) throw new Error(`\u4F1A\u8BDD ${sessionId} \u4E0D\u5C5E\u4E8E\u8BE5 agent`);
  return sessionId;
}
function normalizeBusyPolicy(value) {
  if (value === void 0 || value === null || value === "") return "followUp";
  if (value === "followUp" || value === "steer" || value === "skip") return value;
  throw new Error(`busyPolicy \u53EA\u80FD\u662F followUp / steer / skip\uFF0C\u6536\u5230\uFF1A${String(value)}`);
}
function defaultName(prompt) {
  const head = prompt.trim().split(/[\n。.!?]/)[0]?.trim() ?? "";
  return head.length > 24 ? `${head.slice(0, 24)}\u2026` : head || "\u5916\u90E8\u4E8B\u4EF6";
}
function hookUrl(hookId) {
  return `/api/p/webhook/hooks/${hookId}`;
}
function bearerOf(req) {
  const header = req.header("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}
function readPayload(raw, bytes) {
  if (bytes > MAX_BODY_BYTES) {
    const cut = Buffer.from(raw, "utf-8").subarray(0, MAX_BODY_BYTES).toString("utf-8");
    return {
      payload: safeParse(cut) ?? { truncated: true, note: `body exceeded ${MAX_BODY_BYTES} bytes and was truncated` },
      truncated: true
    };
  }
  if (raw.length === 0) return { payload: void 0, truncated: false };
  return { payload: safeParse(raw) ?? raw, truncated: false };
}
function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function parseBody(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("body \u4E0D\u662F\u5408\u6CD5 JSON");
  }
}
async function callerAgentIdOf(host, sessionId) {
  if (!sessionId) return void 0;
  const session = await host.sessions.get(sessionId);
  return session?.agentId;
}
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}
export {
  src_default as default,
  hookUrl
};
