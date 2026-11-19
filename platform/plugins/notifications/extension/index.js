const parameters = {
  type: "object",
  properties: {
    title: { type: "string", description: "\u77ED\u6807\u9898\uFF08<= 120 \u5B57\u7B26\uFF09" },
    body: { type: "string", description: "\u6B63\u6587\uFF08\u7EAF\u6587\u672C\uFF0C\u4E0D\u8981 markdown\uFF09" },
    severity: {
      type: "string",
      enum: ["info", "warning", "error"],
      description: "info = \u544A\u77E5\uFF0Cwarning = \u9700\u8981\u770B\u4E00\u773C\uFF0Cerror = \u51FA\u9519\u4E86"
    }
  },
  required: ["title", "body"],
  additionalProperties: false
};
var src_default = {
  async init(pi, { bridge }) {
    const api = pi;
    if (!bridge?.call) {
      bridge?.log("warn", "plugin.notifications: bridge.call \u4E0D\u53EF\u7528\uFF0CpostNotification \u672A\u6CE8\u518C");
      return;
    }
    const call = bridge.call.bind(bridge);
    api.registerTool({
      name: "postNotification",
      label: "Post Notification",
      description: "\u5411 server \u901A\u77E5\u4E2D\u5FC3\u53D1\u9001\u4E00\u6761\u6D88\u606F\uFF08\u5199\u8FDB\u6536\u4EF6\u7BB1\uFF0C\u4F9B\u7528\u6237\u7A0D\u540E\u67E5\u770B\uFF1B\u5E73\u53F0\u4E0D\u505A\u5916\u90E8\u63A8\u9001\uFF09",
      promptSnippet: "Post a message to the server notification inbox",
      promptGuidelines: [
        'Use postNotification when the result matters while the user is away \u2014 scheduled/long tasks, failures, or explicit "tell me when done" requests.',
        "Do NOT use it for ordinary replies: if the user is chatting with you, answer in the conversation.",
        "severity: info for progress, warning for something the user should look at, error for failures."
      ],
      parameters,
      execute: async (_toolCallId, params) => {
        try {
          const result = await call("plugin.notifications.post", [params]);
          return {
            content: [{ type: "text", text: JSON.stringify(result ?? { ok: true }) }],
            details: result ?? { ok: true }
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text", text: `Failed to send notification: ${message}` }],
            details: { error: message }
          };
        }
      }
    });
    bridge.log("info", "extension facet registered postNotification");
  }
};
export {
  src_default as default
};
