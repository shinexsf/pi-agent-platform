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
    host.actions.define({
      "hook.create": {
        scope: "public",
        service: true,
        params: { type: "object", additionalProperties: true },
        handler: async (params, ctx) => {
          const callerAgentId = await callerAgentIdOf(host, ctx?.sessionId);
          if (!callerAgentId) throw new Error("\u65E0\u6CD5\u89E3\u6790\u8C03\u7528\u65B9 agent\uFF08\u7F3A\u5C11\u4F1A\u8BDD\u4E0A\u4E0B\u6587\uFF09");
          return api.create(params, callerAgentId);
        }
      },
      "hook.list": {
        scope: "public",
        service: true,
        params: { type: "object", additionalProperties: true },
        handler: async (params, ctx) => api.list(params, await callerAgentIdOf(host, ctx?.sessionId))
      },
      "hook.update": {
        scope: "public",
        service: true,
        params: { type: "object", additionalProperties: true },
        handler: async (params) => api.update(params)
      },
      "hook.delete": {
        scope: "public",
        service: true,
        params: { type: "object", additionalProperties: true },
        handler: async (params, ctx) => api.remove(params, await callerAgentIdOf(host, ctx?.sessionId))
      }
    });
    const manageSchema = {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list", "delete"], description: "create \u521B\u5EFA\uFF1Blist \u5217\u51FA\uFF1Bdelete \u5220\u9664" },
        name: { type: "string", description: "\u77ED\u540D\uFF08\u51FA\u73B0\u5728\u5217\u8868\u4E0E\u5931\u8D25\u901A\u77E5\u91CC\uFF09" },
        prompt: { type: "string", description: "\u4E8B\u4EF6\u5230\u8FBE\u65F6\u8981\u6267\u884C\u7684\u6307\u4EE4\uFF08\u5C31\u662F\u4F60\u5728\u90A3\u4E2A\u4F1A\u8BDD\u91CC\u8BE5\u505A\u7684\u4E8B\uFF09" },
        sessionMode: {
          type: "string",
          enum: ["new", "reuse"],
          description: "new = \u6BCF\u4E2A\u4E8B\u4EF6\u65B0\u5EFA\u4F1A\u8BDD\uFF08\u9ED8\u8BA4\uFF09\uFF1Breuse = \u56FA\u5B9A\u590D\u7528\u4E00\u4E2A\u4F1A\u8BDD\uFF08\u4E0D\u4F20 sessionId \u65F6\u9996\u6B21\u81EA\u52A8\u521B\u5EFA\uFF09"
        },
        sessionId: { type: "string", description: "reuse \u6A21\u5F0F\u4E0B\u7684\u76EE\u6807\u4F1A\u8BDD id\uFF1B\u53EA\u5EFA\u8BAE\u590D\u7528\u5F53\u524D\u4F1A\u8BDD\u65F6\u4F20" },
        busyPolicy: {
          type: "string",
          enum: ["followUp", "steer", "skip"],
          description: "\u6536\u5230\u4E8B\u4EF6\u65F6\u4F60\u6B63\u5728\u8DD1\u600E\u4E48\u529E\uFF1AfollowUp \u6392\u961F\uFF08\u9ED8\u8BA4\uFF09/ steer \u63D2\u961F / skip \u8FD9\u6B21\u4E0D\u6295"
        },
        hookId: { type: "string", description: "delete \u65F6\u7684 hook id" }
      },
      required: ["action"],
      additionalProperties: false
    };
    host.actions.define({
      manage: {
        scope: "own",
        params: manageSchema,
        tool: {
          name: "manage_webhook",
          description: "\u521B\u5EFA / \u67E5\u770B / \u5220\u9664 webhook \u5165\u53E3\uFF1A\u5916\u90E8\u7CFB\u7EDF POST \u5230\u8BE5 URL \u65F6\uFF0C\u5E73\u53F0\u4F1A\u628A\u4F60\u5199\u7684\u6307\u4EE4\u9001\u8FDB\u4E00\u4E2A\u4F1A\u8BDD\u6267\u884C\u3002\u521B\u5EFA\u540E\u8FD4\u56DE\u5B8C\u6574 URL \u4E0E Bearer secret \u2014\u2014 \u628A\u8FD9\u4E24\u4E2A\u4EA4\u7ED9\u8981\u8C03\u7528\u7684\u4E00\u65B9\u5373\u53EF\u3002\u53EA\u7BA1\u7406\u5165\u53E3\u672C\u8EAB\uFF0C\u4E0D\u8FD4\u56DE\u6267\u884C\u7ED3\u679C\u3002",
          exposure: "direct",
          namespace: "webhook",
          promptSnippet: 'manage_webhook: \u521B\u5EFA/\u67E5\u770B/\u5220\u9664 webhook \u5165\u53E3\uFF08\u5916\u90E8\u7CFB\u7EDF POST \u89E6\u53D1\uFF09\uFF1B\u53EA\u5728\u7528\u6237\u660E\u786E\u8981"\u63A5\u5916\u90E8\u4E8B\u4EF6"\u65F6\u4F7F\u7528'
        },
        handler: async (raw, ctx) => {
          const p = raw ?? {};
          const action = String(p.action ?? "");
          const callerAgentId = await callerAgentIdOf(host, ctx?.sessionId);
          if (action === "list") {
            const res2 = api.list({}, callerAgentId);
            const items = res2.items ?? [];
            return {
              ok: true,
              message: items.length === 0 ? "\u5F53\u524D\u6CA1\u6709 webhook \u5165\u53E3\u3002" : `\u5F53\u524D webhook ${items.length} \u4E2A`,
              items
            };
          }
          if (action === "delete") {
            if (!p.hookId) throw new Error('delete \u9700\u8981 hookId\uFF08\u53EF\u5148 action:"list" \u67E5\u770B\uFF09');
            await api.remove({ hookId: p.hookId }, callerAgentId);
            return { ok: true, message: `\u5DF2\u5220\u9664 webhook ${String(p.hookId)}` };
          }
          if (action !== "create") throw new Error(`\u672A\u77E5 action\uFF1A${action}`);
          if (!p.prompt) throw new Error("create \u9700\u8981 prompt\uFF08\u4E8B\u4EF6\u5230\u8FBE\u65F6\u8981\u6267\u884C\u7684\u6307\u4EE4\uFF09");
          const res = await api.create(
            {
              name: p.name,
              prompt: p.prompt,
              sessionMode: p.sessionMode,
              sessionId: p.sessionMode === "reuse" ? p.sessionId : void 0,
              busyPolicy: p.busyPolicy
            },
            callerAgentId
          );
          const hook = res.hook ?? {};
          return {
            ok: true,
            message: `\u5DF2\u521B\u5EFA webhook\u300C${hook.name ?? String(p.name ?? "")}\u300D\uFF08id=${hook.id ?? "?"}\uFF09`,
            url: res.url ?? "",
            secret: hook.secret ?? "",
            hook,
            howToCall: [
              "curl -X POST <\u4F60\u7684\u670D\u52A1\u5730\u5740>" + (res.url ?? ""),
              '  -H "Authorization: Bearer ' + (hook.secret ?? "") + '"',
              '  -H "Content-Type: application/json"',
              `  -d '{"event":"deploy.failed","service":"api"}'`
            ].join(" \\\n"),
            note: "body \u539F\u6837\u8FDB <data>.payload\uFF08\u8BF7\u6C42\u5934\u4FE1\u606F\u5728 _meta\uFF09\uFF1B\u9700\u8981\u53BB\u91CD\u5C31\u8BA9\u5BF9\u65B9\u5E26 Idempotency-Key \u5934\u3002"
          };
        }
      }
    });
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
