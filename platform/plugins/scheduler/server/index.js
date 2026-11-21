import { isValidTimeZone, MIN_CRON_INTERVAL_MINUTES, nextCronTime, parseCronExpr } from "./cron.js";
import { createStore, DDL, OVERLAP_WINDOW_MS } from "./store.js";
const ONCE_GRACE_MS = 3e4;
const MAX_CATCHUP_SLOTS = 500;
const TASK_ID_PREFIX = "task_";
var src_default = {
  init(host) {
    host.bus.declare("scheduler.run.failed", { declaredBy: "publisher" });
    host.db.migrate("scheduler", DDL);
    const store = createStore(host.db);
    const staleCount = store.finalizeStaleRuns();
    if (staleCount > 0) host.log("warn", `\u6536\u5C3E ${staleCount} \u6761\u50F5\u5C38 run\uFF08\u8FDB\u7A0B\u5D29\u6E83\u6B8B\u7559\uFF09`);
    catchUpMissed(host, store);
    const scheduler = createScheduler(host, store);
    const api = {
      list(payload) {
        const p = payload ?? {};
        return { items: store.list({ agentId: p.agentId, includeDisabled: p.includeDisabled }) };
      },
      async create(payload, callerAgentId) {
        const p = { ...payload };
        if (!p.agentId && callerAgentId) p.agentId = callerAgentId;
        const { task } = await createTask(host, store, p);
        scheduler.rearm();
        return task;
      },
      async update(payload) {
        const p = payload ?? {};
        if (!p.taskId) throw new Error("taskId is required");
        const task = await updateTask(host, store, p.taskId, p);
        scheduler.rearm();
        return task;
      },
      remove(payload) {
        const p = payload ?? {};
        if (!p.taskId) throw new Error("taskId is required");
        store.remove(p.taskId);
        scheduler.rearm();
        return { ok: true };
      }
    };
    const callerAgentOf = async (ctx) => ctx.sessionId ? (await host.sessions.get(ctx.sessionId))?.agentId : void 0;
    host.actions.define({
      "task.list": {
        scope: "public",
        service: true,
        params: { type: "object", properties: {}, additionalProperties: true },
        handler: (params) => api.list(params)
      },
      "task.create": {
        scope: "public",
        service: true,
        params: { type: "object", additionalProperties: true },
        handler: async (params, ctx) => api.create(params, await callerAgentOf(ctx))
      },
      "task.update": {
        scope: "public",
        service: true,
        params: { type: "object", additionalProperties: true },
        handler: (params) => api.update(params)
      },
      "task.delete": {
        scope: "public",
        service: true,
        params: { type: "object", additionalProperties: true },
        handler: (params) => api.remove(params)
      },
      "task.run": {
        scope: "public",
        service: true,
        params: {
          type: "object",
          properties: { taskId: { type: "string" } },
          required: ["taskId"],
          additionalProperties: false
        },
        handler: async (params) => {
          const p = params ?? {};
          if (!p.taskId) throw new Error("taskId is required");
          return dispatch(host, store, p.taskId, "plugin");
        }
      }
    });
    const aggregateSchema = {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "cancel"],
          description: "create \u521B\u5EFA\uFF1Blist \u5217\u51FA\u5F53\u524D\u5DE5\u4F5C\u533A/agent \u7684\u5B9A\u65F6\u4EFB\u52A1\uFF1Bcancel \u6309 taskId \u53D6\u6D88"
        },
        name: { type: "string", description: "\u4EFB\u52A1\u540D\uFF08\u7528\u4E8E\u5217\u8868\u4E0E\u901A\u77E5\uFF0C\u7B80\u77ED\uFF09" },
        prompt: { type: "string", description: "\u5230\u70B9\u65F6\u8981\u6267\u884C\u7684\u6307\u4EE4\uFF08\u5C31\u662F\u4F60\u5728\u90A3\u4E2A\u4F1A\u8BDD\u91CC\u8BE5\u505A\u7684\u4E8B\uFF09" },
        scheduleKind: {
          type: "string",
          enum: ["cron", "once"],
          description: "cron = \u91CD\u590D\uFF08\u9700 cronExpr + timezone\uFF09\uFF1Bonce = \u4E00\u6B21\u6027\uFF08\u9700 at\uFF09"
        },
        cronExpr: {
          type: "string",
          description: "5 \u6BB5 cron\uFF08\u5206 \u65F6 \u65E5 \u6708 \u5468\uFF09\uFF0C\u6700\u5C0F\u95F4\u9694 5 \u5206\u949F\uFF0C\u4F8B\uFF1A`0 9 * * *` = \u6BCF\u5929 9:00"
        },
        timezone: { type: "string", description: "IANA \u65F6\u533A\uFF0C\u4F8B\uFF1A`Asia/Shanghai`\u3002\u7F3A\u7701 UTC" },
        at: { type: "string", description: "\u4E00\u6B21\u6027\u4EFB\u52A1\u7684\u65F6\u523B\uFF0CISO 8601\uFF08\u4F8B\uFF1A`2026-11-20T09:00:00+08:00`\uFF09" },
        sessionMode: {
          type: "string",
          enum: ["new", "reuse"],
          description: "new = \u6BCF\u6B21\u89E6\u53D1\u65B0\u5EFA\u4F1A\u8BDD\uFF08\u9ED8\u8BA4\uFF09\uFF1Breuse = \u56FA\u5B9A\u590D\u7528\u4E00\u4E2A\u4F1A\u8BDD\uFF08\u4E0D\u4F20 sessionId \u65F6\u9996\u6B21\u89E6\u53D1\u81EA\u52A8\u521B\u5EFA\uFF09"
        },
        sessionId: { type: "string", description: "reuse \u6A21\u5F0F\u4E0B\u7684\u76EE\u6807\u4F1A\u8BDD id\uFF1B\u53EA\u5EFA\u8BAE\u590D\u7528\u5F53\u524D\u4F1A\u8BDD\u65F6\u4F20" },
        busyPolicy: {
          type: "string",
          enum: ["followUp", "steer", "skip"],
          description: "\u5230\u70B9\u65F6 agent \u6B63\u5728\u8DD1\u600E\u4E48\u529E\uFF1AfollowUp \u6392\u961F\uFF08\u9ED8\u8BA4\uFF09/ steer \u63D2\u961F / skip \u8FD9\u4E00\u6B21\u4E0D\u6295\u3002\u9AD8\u9891\u4EFB\u52A1\u5EFA\u8BAE skip"
        },
        taskId: { type: "string", description: "cancel \u65F6\u7684\u4EFB\u52A1 id" }
      },
      required: ["action"],
      additionalProperties: false
    };
    host.actions.define({
      schedule: {
        scope: "own",
        params: aggregateSchema,
        tool: {
          // 覆盖派生名：模型侧看到的仍是 schedule_task（skill 与文档都按这个名字写的）。
          name: "schedule_task",
          description: "\u521B\u5EFA / \u67E5\u770B / \u53D6\u6D88\u5B9A\u65F6\u4EFB\u52A1\uFF1A\u6309 cron \u8868\u8FBE\u5F0F\u6216\u4E00\u4E2A\u5177\u4F53\u65F6\u523B\uFF0C\u628A\u4E00\u6BB5\u6307\u4EE4\u5728\u6307\u5B9A\u4F1A\u8BDD\u91CC\u81EA\u52A8\u6267\u884C\u3002\u53EA\u7BA1\u7406\u4EFB\u52A1\u672C\u8EAB\uFF0C\u4E0D\u8FD4\u56DE\u6267\u884C\u7ED3\u679C\uFF08\u4EFB\u52A1\u4F1A\u5728\u5230\u70B9\u65F6\u72EC\u7ACB\u8FD0\u884C\uFF09\u3002",
          // 常驻而不是 deferred：用户说"每天…"时必须随手可用，藏进 tool_search 会漏用。
          exposure: "direct",
          namespace: "scheduler",
          promptSnippet: 'schedule_task: \u521B\u5EFA/\u67E5\u770B/\u53D6\u6D88\u5B9A\u65F6\u4EFB\u52A1\uFF08cron \u6216\u4E00\u6B21\u6027\u65F6\u523B\uFF09\uFF1B\u53EA\u5728\u7528\u6237\u660E\u786E\u8981\u6C42"\u5B9A\u65F6/\u6BCF\u5929/\u63D0\u9192"\u65F6\u4F7F\u7528'
        },
        handler: async (raw, ctx) => {
          const p = raw ?? {};
          const action = String(p.action ?? "");
          if (action === "list") {
            const res = api.list({});
            return { ok: true, message: `\u5F53\u524D\u5B9A\u65F6\u4EFB\u52A1 ${res.items?.length ?? 0} \u4E2A`, items: res.items ?? [] };
          }
          if (action === "cancel") {
            if (!p.taskId) throw new Error('cancel \u9700\u8981 taskId\uFF08\u53EF\u5148 action:"list" \u67E5\u770B\uFF09');
            api.remove({ taskId: p.taskId });
            return { ok: true, message: `\u5DF2\u53D6\u6D88\u4EFB\u52A1 ${String(p.taskId)}` };
          }
          if (action !== "create") throw new Error(`\u672A\u77E5 action\uFF1A${action}`);
          if (!p.prompt) throw new Error("create \u9700\u8981 prompt\uFF08\u5230\u70B9\u8981\u6267\u884C\u7684\u6307\u4EE4\uFF09");
          const scheduleKind = p.scheduleKind === "once" ? "once" : "cron";
          let at;
          if (scheduleKind === "once") {
            if (!p.at) throw new Error("\u4E00\u6B21\u6027\u4EFB\u52A1\u9700\u8981 at\uFF08ISO 8601 \u65F6\u95F4\uFF09");
            const parsed = Date.parse(String(p.at));
            if (Number.isNaN(parsed)) throw new Error(`at \u4E0D\u662F\u5408\u6CD5\u65F6\u95F4\uFF1A${String(p.at)}`);
            at = parsed;
          }
          const task = await api.create(
            {
              name: p.name,
              prompt: p.prompt,
              scheduleKind,
              cronExpr: p.cronExpr,
              timezone: p.timezone,
              at,
              sessionMode: p.sessionMode,
              sessionId: p.sessionMode === "reuse" ? p.sessionId : void 0,
              busyPolicy: p.busyPolicy
            },
            await callerAgentOf(ctx)
          );
          const when = task.nextAt ? new Date(task.nextAt).toLocaleString("zh-CN", { timeZone: String(p.timezone ?? "UTC") }) : "\u672A\u77E5";
          return {
            ok: true,
            message: `\u5DF2\u521B\u5EFA\u5B9A\u65F6\u4EFB\u52A1\u300C${task.name ?? String(p.name ?? "")}\u300D\uFF08id=${task.id ?? "?"}\uFF09\uFF0C\u4E0B\u6B21\u8FD0\u884C\uFF1A${when}`,
            task
          };
        }
      }
    });
    const route = (method, path, handler) => {
      host.http.route({ method, path, handler });
    };
    route("GET", "/tasks", (req) => ({
      json: { items: store.list({ agentId: req.query.agentId, includeDisabled: req.query.includeDisabled === "1" }) }
    }));
    route("GET", "/tasks/:id", (req) => {
      const task = store.get(req.params.id);
      if (!task) return { status: 404, json: { error: "task not found" } };
      return { json: { task, runs: store.listRuns(task.id, 50) } };
    });
    route("POST", "/tasks", async (req) => {
      try {
        const { task } = await createTask(host, store, parseBody(req.body));
        scheduler.rearm();
        return { status: 201, json: task };
      } catch (err) {
        return { status: 400, json: { error: messageOf(err) } };
      }
    });
    const updateHandler = async (req) => {
      try {
        const task = await updateTask(host, store, req.params.id, parseBody(req.body));
        scheduler.rearm();
        return { json: task };
      } catch (err) {
        const msg = messageOf(err);
        return { status: msg.includes("max_runs") || msg.includes("\u4E0A\u9650") ? 409 : 400, json: { error: msg } };
      }
    };
    route("PATCH", "/tasks/:id", updateHandler);
    route("PUT", "/tasks/:id", updateHandler);
    route("DELETE", "/tasks/:id", (req) => {
      store.remove(req.params.id);
      scheduler.rearm();
      return { json: { ok: true } };
    });
    route("POST", "/tasks/:id/run", async (req) => {
      const result = await dispatch(host, store, req.params.id, "manual");
      const status = result.status === "delivered" ? 202 : result.status === "skipped" ? 409 : 400;
      return { status, json: result };
    });
    route("GET", "/tasks/:id/runs", (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
      return { json: { items: store.listRuns(req.params.id, limit) } };
    });
    route("GET", "/meta", async () => ({
      json: {
        agents: (await host.agents.list()).map((a) => ({ id: a.id, name: a.name })),
        defaultTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        minIntervalMinutes: MIN_CRON_INTERVAL_MINUTES,
        now: Date.now()
      }
    }));
    route("GET", "/sessions", async (req) => {
      const agentId = req.query.agentId;
      const items = (await host.sessions.list()).filter((s) => agentId ? s.agentId === agentId : true).map((s) => ({ id: s.id, agentId: s.agentId, status: s.status }));
      return { json: { items } };
    });
    route("POST", "/preview", (req) => {
      const body = parseBody(req.body);
      try {
        const nextAt = computeNextAt(body, Date.now());
        return { json: { ok: true, nextAt } };
      } catch (err) {
        return { status: 400, json: { ok: false, error: messageOf(err) } };
      }
    });
    host.ui.page({ path: "/scheduler", label: "\u5B9A\u65F6\u4EFB\u52A1", icon: "automation", component: "list", order: 15 });
    host.ui.page({ path: "/scheduler/new", label: "\u65B0\u5EFA\u5B9A\u65F6\u4EFB\u52A1", icon: "automation", component: "editor", nav: false });
    host.ui.page({ path: "/scheduler/:id", label: "\u5B9A\u65F6\u4EFB\u52A1", icon: "automation", component: "editor", nav: false });
    scheduler.start();
    return () => {
      scheduler.dispose();
    };
  }
};
function computeNextAt(input, from) {
  if (input.scheduleKind === "once") {
    const at = Number(input.at);
    if (!Number.isFinite(at)) throw new Error("at \u5FC5\u987B\u662F\u6BEB\u79D2\u65F6\u95F4\u6233");
    if (at < from - ONCE_GRACE_MS) throw new Error("\u4E00\u6B21\u6027\u4EFB\u52A1\u7684\u65F6\u95F4\u5FC5\u987B\u662F\u5C06\u6765\u7684\u65F6\u523B");
    return at;
  }
  if (input.scheduleKind !== "cron") throw new Error("scheduleKind \u53EA\u80FD\u662F cron \u6216 once");
  const expr = (input.cronExpr ?? "").trim();
  if (!expr) throw new Error("cron \u8868\u8FBE\u5F0F\u4E0D\u80FD\u4E3A\u7A7A");
  const tz = (input.timezone ?? "").trim();
  if (!tz) throw new Error("\u65F6\u533A\u4E0D\u80FD\u4E3A\u7A7A");
  if (!isValidTimeZone(tz)) throw new Error(`\u672A\u77E5\u65F6\u533A\uFF1A${tz}`);
  parseCronExpr(expr);
  const first = nextCronTime(expr, tz, from);
  if (first === null) throw new Error("cron \u8868\u8FBE\u5F0F\u6C38\u8FDC\u4E0D\u4F1A\u89E6\u53D1");
  const second = nextCronTime(expr, tz, first);
  if (second !== null && second - first < MIN_CRON_INTERVAL_MINUTES * 6e4) {
    throw new Error(`cron \u6700\u5C0F\u95F4\u9694\u662F ${MIN_CRON_INTERVAL_MINUTES} \u5206\u949F`);
  }
  return first;
}
async function createTask(host, store, input) {
  const agentId = input.agentId?.trim();
  if (!agentId) throw new Error("agentId \u4E0D\u80FD\u4E3A\u7A7A");
  if (!host.agents.get(agentId)) throw new Error(`agent \u4E0D\u5B58\u5728\uFF1A${agentId}`);
  const prompt = input.prompt?.trim();
  if (!prompt) throw new Error("prompt \u4E0D\u80FD\u4E3A\u7A7A");
  const scheduleKind = input.scheduleKind ?? "cron";
  const sessionMode = input.sessionMode ?? "new";
  const busyPolicy = normalizeBusyPolicy(input.busyPolicy);
  const sessionId = await normalizeSessionBinding(host, agentId, sessionMode, input.sessionId);
  const nextAt = computeNextAt(
    { scheduleKind, cronExpr: input.cronExpr, timezone: input.timezone, at: input.at },
    Date.now()
  );
  const task = store.insert({
    agentId,
    name: input.name?.trim() || defaultName(input),
    prompt,
    scheduleKind,
    cronExpr: scheduleKind === "cron" ? (input.cronExpr ?? "").trim() : null,
    timezone: scheduleKind === "cron" ? (input.timezone ?? "").trim() : null,
    at: scheduleKind === "once" ? Number(input.at) : null,
    sessionMode,
    sessionId,
    busyPolicy,
    enabled: true,
    nextAt,
    // 一次性任务跑一次就停（旧版同款：创建时把 max_runs 钉成 1）。
    maxRuns: scheduleKind === "once" ? 1 : input.maxRuns ?? null
  });
  host.log("info", `created task ${task.id} (${task.scheduleKind})`);
  return { task };
}
async function updateTask(host, store, taskId, input) {
  const task = store.get(taskId);
  if (!task) throw new Error(`\u4EFB\u52A1\u4E0D\u5B58\u5728\uFF1A${taskId}`);
  const patch = {};
  if (input.name !== void 0) patch.name = input.name.trim() || task.name;
  if (input.prompt !== void 0) {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("prompt \u4E0D\u80FD\u4E3A\u7A7A");
    patch.prompt = prompt;
  }
  const nextMode = input.sessionMode ?? task.sessionMode;
  if (input.sessionMode !== void 0 || input.sessionId !== void 0) {
    patch.session_mode = nextMode;
    patch.session_id = await normalizeSessionBinding(host, task.agentId, nextMode, input.sessionId, task.sessionId);
  }
  if (input.busyPolicy !== void 0) patch.busy_policy = normalizeBusyPolicy(input.busyPolicy);
  if (input.maxRuns !== void 0 && task.scheduleKind !== "once") patch.max_runs = input.maxRuns;
  if (input.enabled !== void 0 && input.enabled !== task.enabled) {
    if (input.enabled) {
      if (task.maxRuns !== null && task.runsCount >= task.maxRuns) {
        throw new Error(`\u5DF2\u8FBE max_runs \u4E0A\u9650\uFF08${task.maxRuns}\uFF09\uFF0C\u5148\u63D0\u9AD8\u4E0A\u9650\u518D\u542F\u7528`);
      }
      patch.enabled = 1;
      patch.next_at = computeNextAt(
        { scheduleKind: task.scheduleKind, cronExpr: task.cronExpr ?? void 0, timezone: task.timezone ?? void 0, at: task.at ?? void 0 },
        Date.now()
      );
    } else {
      patch.enabled = 0;
      patch.next_at = null;
    }
  } else if (input.reschedule) {
    patch.next_at = computeNextAt(
      {
        scheduleKind: task.scheduleKind,
        cronExpr: input.cronExpr ?? task.cronExpr ?? void 0,
        timezone: input.timezone ?? task.timezone ?? void 0,
        at: input.at ?? task.at ?? void 0
      },
      Date.now()
    );
    if (input.cronExpr !== void 0) patch.cron_expr = input.cronExpr.trim();
    if (input.timezone !== void 0) patch.timezone = input.timezone.trim();
  }
  store.update(taskId, patch);
  return store.get(taskId);
}
function normalizeBusyPolicy(value) {
  if (value === void 0 || value === null || value === "") return "followUp";
  if (value === "followUp" || value === "steer" || value === "skip") return value;
  throw new Error(`busyPolicy \u53EA\u80FD\u662F followUp / steer / skip\uFF0C\u6536\u5230\uFF1A${String(value)}`);
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
function defaultName(input) {
  if (input.scheduleKind === "once" && input.at) {
    return `\u4E00\u6B21\u6027\u4EFB\u52A1 ${new Date(Number(input.at)).toISOString().slice(0, 16).replace("T", " ")}`;
  }
  return `\u5B9A\u65F6\u4EFB\u52A1 ${input.cronExpr ?? ""}`.trim();
}
async function dispatch(host, store, taskId, triggeredBy) {
  const task = store.get(taskId);
  if (!task) return { status: "skipped", reason: "task-not-found" };
  if (!task.enabled) {
    const runId2 = store.createRun({ taskId, status: "skipped", triggeredBy, reason: "disabled" });
    return { status: "skipped", runId: runId2, reason: "disabled" };
  }
  if (store.hasOpenRun(taskId, Date.now() - OVERLAP_WINDOW_MS)) {
    const runId2 = store.createRun({ taskId, status: "skipped", triggeredBy, reason: "overlap" });
    host.log("info", `task ${taskId} skipped: overlap`);
    return { status: "skipped", runId: runId2, reason: "overlap" };
  }
  const runId = store.createRun({ taskId, status: "failed", triggeredBy, finished: false });
  try {
    const session = await host.sessions.ensure({
      agentId: task.agentId,
      ...task.sessionMode === "reuse" && task.sessionId ? { sessionId: task.sessionId } : {},
      ...task.sessionMode === "reuse" && !task.sessionId ? { title: `[${task.name}]` } : {}
    });
    if (task.busyPolicy === "skip" && await host.sessions.status(session.sessionId) === "running") {
      store.finishRun(runId, { status: "skipped", reason: "busy" });
      host.log("info", `task ${taskId} skipped: busy (session ${session.sessionId} running)`);
      return { status: "skipped", runId, sessionId: session.sessionId, reason: "busy" };
    }
    await host.sessions.systemEvent({
      sessionId: session.sessionId,
      kind: "trigger",
      source: task.scheduleKind,
      name: task.name,
      run: runId,
      instruction: task.prompt,
      // 空闲时传了也无害（pi 只在流式中看它），所以不必先查状态 —— 少一次 TOCTOU。
      ...task.busyPolicy === "skip" ? {} : { streamingBehavior: task.busyPolicy }
    });
    store.finishRun(runId, { status: "delivered", sessionId: session.sessionId });
    const runsCount = task.runsCount + 1;
    const patch = { runs_count: runsCount, last_fired_at: Date.now() };
    if (task.sessionMode === "reuse" && !task.sessionId) patch.session_id = session.sessionId;
    if (task.maxRuns !== null && runsCount >= task.maxRuns) {
      patch.enabled = 0;
      patch.next_at = null;
      host.log("info", `task ${taskId} reached max_runs (${task.maxRuns}) \u2014 disabled`);
    }
    store.update(taskId, patch);
    host.log("info", `task ${taskId} delivered \u2192 session ${session.sessionId} (${triggeredBy})`);
    return { status: "delivered", runId, sessionId: session.sessionId };
  } catch (err) {
    const reason = messageOf(err);
    store.finishRun(runId, { status: "failed", reason });
    host.log("warn", `task ${taskId} delivery failed: ${reason}`);
    const published = host.bus.publish("scheduler.run.failed", {
      taskId,
      runId,
      name: task.name,
      agentId: task.agentId,
      reason,
      actionUrl: `/scheduler/${taskId}`
    });
    if (published.delivered === 0) {
      host.log("debug", `run failed but no notification subscriber (topic=${"scheduler.run.failed"})`);
    }
    return { status: "failed", runId, reason };
  }
}
function createScheduler(host, store) {
  let timer = null;
  let disposed = false;
  const MAX_DELAY = 2 ** 31 - 1;
  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function arm() {
    if (disposed) return;
    clear();
    const nextAt = store.earliestNextAt();
    if (nextAt === null) return;
    const delay = Math.max(0, Math.min(nextAt - Date.now(), MAX_DELAY));
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, delay);
    timer.unref?.();
  }
  async function tick() {
    if (disposed) return;
    try {
      const now = Date.now();
      for (const task of store.due(now)) {
        if (disposed) return;
        const nextSlot = task.scheduleKind === "cron" ? nextCronTime(task.cronExpr ?? "", task.timezone ?? "UTC", now) : null;
        if (!store.claimNextAt(task.id, task.nextAt, nextSlot)) continue;
        const result = await dispatch(host, store, task.id, "schedule");
        if (result.status === "delivered" || result.status === "failed") {
          host.log("debug", `tick ${task.id} \u2192 ${result.status}`);
        }
      }
    } catch (err) {
      host.log("error", `scheduler tick failed: ${messageOf(err)}`);
    } finally {
      if (!disposed) arm();
    }
  }
  return {
    start: arm,
    rearm: arm,
    tick,
    dispose() {
      disposed = true;
      clear();
    }
  };
}
function catchUpMissed(host, store) {
  const now = Date.now();
  for (const task of store.due(now)) {
    let nextAt = null;
    let missed = 0;
    if (task.scheduleKind === "cron") {
      let cursor = task.nextAt ?? now;
      nextAt = nextCronTime(task.cronExpr ?? "", task.timezone ?? "UTC", cursor);
      while (nextAt !== null && nextAt <= now && missed < MAX_CATCHUP_SLOTS) {
        missed += 1;
        cursor = nextAt;
        nextAt = nextCronTime(task.cronExpr ?? "", task.timezone ?? "UTC", cursor);
      }
      missed += 1;
    } else {
      missed = 1;
      nextAt = null;
    }
    store.claimNextAt(task.id, task.nextAt, nextAt);
    store.createRun({ taskId: task.id, status: "missed", triggeredBy: "schedule", reason: `missed ${missed} slot(s) while stopped` });
    if (task.scheduleKind === "once") store.update(task.id, { enabled: 0 });
    host.log("info", `task ${task.id}: ${missed} slot(s) missed while stopped \u2014 not replayed`);
  }
}
function parseBody(body) {
  if (!body.trim()) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error("\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON");
  }
}
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}
export {
  src_default as default
};
