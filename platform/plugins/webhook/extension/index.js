var src_default = {
  async init(pi, { bridge }) {
    const api = pi;
    if (!bridge?.call) {
      bridge?.log("warn", "plugin.webhook: bridge.call \u4E0D\u53EF\u7528\uFF0Cmanage_webhook \u672A\u6CE8\u518C");
      return;
    }
    const call = bridge.call.bind(bridge);
    api.registerTool({
      name: "manage_webhook",
      label: "Webhook",
      description: "\u521B\u5EFA / \u67E5\u770B / \u5220\u9664 webhook \u5165\u53E3\uFF1A\u5916\u90E8\u7CFB\u7EDF POST \u5230\u8BE5 URL \u65F6\uFF0C\u5E73\u53F0\u4F1A\u628A\u4F60\u5199\u7684\u6307\u4EE4\u9001\u8FDB\u4E00\u4E2A\u4F1A\u8BDD\u6267\u884C\u3002\u521B\u5EFA\u540E\u8FD4\u56DE\u5B8C\u6574 URL \u4E0E Bearer secret \u2014\u2014 \u628A\u8FD9\u4E24\u4E2A\u4EA4\u7ED9\u8981\u8C03\u7528\u7684\u4E00\u65B9\u5373\u53EF\u3002\u53EA\u7BA1\u7406\u5165\u53E3\u672C\u8EAB\uFF0C\u4E0D\u8FD4\u56DE\u6267\u884C\u7ED3\u679C\u3002",
      promptSnippet: 'manage_webhook: \u521B\u5EFA/\u67E5\u770B/\u5220\u9664 webhook \u5165\u53E3\uFF08\u5916\u90E8\u7CFB\u7EDF POST \u89E6\u53D1\uFF09\uFF1B\u53EA\u5728\u7528\u6237\u660E\u786E\u8981"\u63A5\u5916\u90E8\u4E8B\u4EF6"\u65F6\u4F7F\u7528',
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "list", "delete"], description: "create \u521B\u5EFA\uFF1Blist \u5217\u51FA\uFF1Bdelete \u5220\u9664" },
          // ── create ──
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
          // ── delete ──
          hookId: { type: "string", description: "delete \u65F6\u7684 hook id" }
        },
        required: ["action"],
        additionalProperties: false
      },
      execute: async (_toolCallId, params) => {
        const action = String(params?.action ?? "");
        if (action === "list") {
          const res = await call("plugin.webhook.hook.list", [{}]);
          const items = res.items ?? [];
          if (items.length === 0) return text("\u5F53\u524D\u6CA1\u6709 webhook \u5165\u53E3\u3002");
          return text(
            `\u5F53\u524D webhook ${items.length} \u4E2A\uFF1A
${items.map((i) => `- ${i.id} \xB7 ${i.name}${i.enabled ? "" : "\uFF08\u5DF2\u505C\u7528\uFF09"}`).join("\n")}`
          );
        }
        if (action === "delete") {
          if (!params?.hookId) return text('delete \u9700\u8981 hookId\uFF08\u53EF\u5148 action:"list" \u67E5\u770B\uFF09', true);
          await call("plugin.webhook.hook.delete", [{ hookId: params.hookId }]);
          return text(`\u5DF2\u5220\u9664 webhook ${params.hookId}`);
        }
        if (action !== "create") return text(`\u672A\u77E5 action\uFF1A${action}`, true);
        if (!params?.prompt) return text("create \u9700\u8981 prompt\uFF08\u4E8B\u4EF6\u5230\u8FBE\u65F6\u8981\u6267\u884C\u7684\u6307\u4EE4\uFF09", true);
        try {
          const res = await call("plugin.webhook.hook.create", [
            {
              // agentId 由 server 侧按调用方会话补，这里不猜。
              name: params.name,
              prompt: params.prompt,
              sessionMode: params.sessionMode,
              sessionId: params.sessionMode === "reuse" ? params.sessionId : void 0,
              busyPolicy: params.busyPolicy
            }
          ]);
          const hook = res.hook ?? {};
          return text(
            [
              `\u5DF2\u521B\u5EFA webhook\u300C${hook.name ?? params.name ?? ""}\u300D\uFF08id=${hook.id}\uFF09\u3002`,
              "",
              `URL\uFF1A${res.url ?? ""}`,
              `Secret\uFF1A${hook.secret ?? ""}`,
              "",
              "\u8C03\u7528\u65B9\u5F0F\uFF1A",
              "```",
              `curl -X POST <\u4F60\u7684\u670D\u52A1\u5730\u5740>${res.url ?? ""} \\`,
              `  -H "Authorization: Bearer ${hook.secret ?? ""}" \\`,
              '  -H "Content-Type: application/json" \\',
              `  -d '{"event":"deploy.failed","service":"api"}'`,
              "```",
              "body \u539F\u6837\u8FDB <data>.payload\uFF08\u8BF7\u6C42\u5934\u4FE1\u606F\u5728 _meta\uFF09\uFF1B\u9700\u8981\u53BB\u91CD\u5C31\u8BA9\u5BF9\u65B9\u5E26 `Idempotency-Key` \u5934\u3002"
            ].join("\n")
          );
        } catch (err) {
          return text(`\u521B\u5EFA\u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}`, true);
        }
      }
    });
    bridge.log("info", "extension facet registered manage_webhook");
  }
};
function text(value, isError = false) {
  return { content: [{ type: "text", text: value }], ...isError ? { isError: true } : {} };
}
export {
  src_default as default
};
