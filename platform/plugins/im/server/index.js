import { createGateway } from "./gateway.js";
import { registerRoutes } from "./routes.js";
import { createStateStore } from "./state.js";
var src_default = {
  init(host) {
    const state = createStateStore(host.dataDir, (level, msg, extra) => {
      if (level === "warn") host.log("warn", msg, extra);
      else host.log("info", msg, extra);
    });
    const gateway = createGateway({ host, state });
    host.ui.page({ path: "/im", label: "IM", icon: "im", component: "gateway", parent: "/config", order: 30 });
    registerRoutes(host.http.route, gateway);
    host.actions.define({
      sendFile: {
        scope: "own",
        params: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Absolute path to the file to send" },
            fileName: {
              type: "string",
              description: "Friendly display name without extension (system auto-appends the correct extension from the actual file)"
            }
          },
          required: ["filePath"],
          additionalProperties: false
        },
        tool: {
          name: "sendFileToUser",
          description: "Send a file to the user through the active IM channel (QQ / WeChat). Use absolute paths inside the workspace.",
          exposure: "direct",
          namespace: "im",
          promptSnippet: "Send a file to the user via IM",
          promptGuidelines: [
            "Use sendFileToUser when the user should receive an actual file (report, image, archive) rather than a path in chat."
          ]
        },
        handler: async (params, ctx) => {
          const p = params ?? {};
          const filePath = (p.filePath ?? "").trim();
          if (!filePath) throw new Error("sendFileToUser: filePath required");
          const sessionId = ctx.sessionId;
          if (!sessionId) throw new Error("sendFileToUser: \u53EA\u5728\u4F1A\u8BDD\u5185\u53EF\u7528");
          const result = await gateway.sendFileToSession(sessionId, { filePath });
          if (!result.ok) throw new Error(result.reason ?? "sendFileToUser failed");
          return { ok: true, filePath };
        }
      }
    });
    const offLoaded = host.bus.subscribe("__core__.plugin.loaded", () => void gateway.rescan());
    const offUnloaded = host.bus.subscribe("__core__.plugin.unloaded", () => void gateway.rescan());
    void gateway.rescan();
    host.log("info", "IM \u7F51\u5173\u5DF2\u5C31\u7EEA", { dataDir: host.dataDir, stateFile: state.file });
    return async () => {
      offLoaded.dispose();
      offUnloaded.dispose();
      await gateway.dispose();
    };
  }
};
export {
  src_default as default
};
