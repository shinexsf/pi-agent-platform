var src_default = {
  async init(pi, { bridge }) {
    const api = pi;
    if (!bridge?.call) {
      bridge?.log("warn", "plugin.scheduler: bridge.call \u4E0D\u53EF\u7528\uFF0Cschedule_task \u672A\u6CE8\u518C");
      return;
    }
    const call = bridge.call.bind(bridge);
    api.registerTool({
      name: "schedule_task",
      label: "\u5B9A\u65F6\u4EFB\u52A1",
      description: "\u521B\u5EFA / \u67E5\u770B / \u53D6\u6D88\u5B9A\u65F6\u4EFB\u52A1\uFF1A\u6309 cron \u8868\u8FBE\u5F0F\u6216\u4E00\u4E2A\u5177\u4F53\u65F6\u523B\uFF0C\u628A\u4E00\u6BB5\u6307\u4EE4\u5728\u6307\u5B9A\u4F1A\u8BDD\u91CC\u81EA\u52A8\u6267\u884C\u3002\u53EA\u7BA1\u7406\u4EFB\u52A1\u672C\u8EAB\uFF0C\u4E0D\u8FD4\u56DE\u6267\u884C\u7ED3\u679C\uFF08\u4EFB\u52A1\u4F1A\u5728\u5230\u70B9\u65F6\u72EC\u7ACB\u8FD0\u884C\uFF09\u3002",
      promptSnippet: 'schedule_task: \u521B\u5EFA/\u67E5\u770B/\u53D6\u6D88\u5B9A\u65F6\u4EFB\u52A1\uFF08cron \u6216\u4E00\u6B21\u6027\u65F6\u523B\uFF09\uFF1B\u53EA\u5728\u7528\u6237\u660E\u786E\u8981\u6C42"\u5B9A\u65F6/\u6BCF\u5929/\u63D0\u9192"\u65F6\u4F7F\u7528',
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "list", "cancel"],
            description: "create \u521B\u5EFA\uFF1Blist \u5217\u51FA\u5F53\u524D\u5DE5\u4F5C\u533A/agent \u7684\u5B9A\u65F6\u4EFB\u52A1\uFF1Bcancel \u6309 taskId \u53D6\u6D88"
          },
          // ── create ──
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
            description: "\u5230\u70B9\u65F6 agent \u6B63\u5728\u8DD1\u600E\u4E48\u529E\uFF1AfollowUp \u6392\u961F\uFF08\u9ED8\u8BA4\uFF0C\u4E0D\u4E22\u8FD9\u4E00\u8F6E\uFF09/ steer \u63D2\u961F / skip \u8FD9\u4E00\u6B21\u4E0D\u6295\u3002\u9AD8\u9891\u4EFB\u52A1\uFF08\u95F4\u9694\u5C0F\u4E8E\u5355\u8F6E\u8017\u65F6\uFF09\u5EFA\u8BAE skip"
          },
          // ── cancel ──
          taskId: { type: "string", description: "cancel \u65F6\u7684\u4EFB\u52A1 id" }
        },
        required: ["action"],
        additionalProperties: false
      },
      execute: async (_toolCallId, params) => {
        const action = String(params?.action ?? "");
        if (action === "list") {
          const res = await call("plugin.scheduler.task.list", [{}]);
          return text(`\u5F53\u524D\u5B9A\u65F6\u4EFB\u52A1 ${res.items?.length ?? 0} \u4E2A\uFF1A
${JSON.stringify(res.items ?? [], null, 2)}`);
        }
        if (action === "cancel") {
          if (!params?.taskId) return text('cancel \u9700\u8981 taskId\uFF08\u53EF\u5148 action:"list" \u67E5\u770B\uFF09', true);
          await call("plugin.scheduler.task.delete", [{ taskId: params.taskId }]);
          return text(`\u5DF2\u53D6\u6D88\u4EFB\u52A1 ${params.taskId}`);
        }
        if (action !== "create") return text(`\u672A\u77E5 action\uFF1A${action}`, true);
        if (!params?.prompt) return text("create \u9700\u8981 prompt\uFF08\u5230\u70B9\u8981\u6267\u884C\u7684\u6307\u4EE4\uFF09", true);
        const scheduleKind = params.scheduleKind === "once" ? "once" : "cron";
        let at;
        if (scheduleKind === "once") {
          if (!params.at) return text("\u4E00\u6B21\u6027\u4EFB\u52A1\u9700\u8981 at\uFF08ISO 8601 \u65F6\u95F4\uFF09", true);
          const parsed = Date.parse(String(params.at));
          if (Number.isNaN(parsed)) return text(`at \u4E0D\u662F\u5408\u6CD5\u65F6\u95F4\uFF1A${params.at}`, true);
          at = parsed;
        }
        try {
          const task = await call("plugin.scheduler.task.create", [
            {
              // agentId 由 server 侧补（ctx 里带着调用方会话），这里不猜。
              name: params.name,
              prompt: params.prompt,
              scheduleKind,
              cronExpr: params.cronExpr,
              timezone: params.timezone,
              at,
              sessionMode: params.sessionMode,
              sessionId: params.sessionMode === "reuse" ? params.sessionId : void 0,
              busyPolicy: params.busyPolicy
            }
          ]);
          const when = task.nextAt ? new Date(task.nextAt).toLocaleString("zh-CN", { timeZone: String(params.timezone ?? "UTC") }) : "\u672A\u77E5";
          return text(`\u5DF2\u521B\u5EFA\u5B9A\u65F6\u4EFB\u52A1\u300C${task.name ?? params.name ?? ""}\u300D\uFF08id=${task.id}\uFF09\uFF0C\u4E0B\u6B21\u8FD0\u884C\uFF1A${when}`);
        } catch (err) {
          return text(`\u521B\u5EFA\u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}`, true);
        }
      }
    });
    bridge.log("info", "extension facet registered schedule_task");
  }
};
function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
function text(value, isError = false) {
  return { content: [{ type: "text", text: value }], ...isError ? { isError: true } : {} };
}
export {
  src_default as default
};
