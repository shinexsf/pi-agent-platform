const NO_ARGS = { type: "object", properties: {}, additionalProperties: false };
function logCall(host, action, ctx, target, result, extra = {}) {
  host.log(result === "ok" ? "info" : "warn", `action ${action} ${result}`, {
    action,
    callerSessionId: ctx?.sessionId ?? null,
    callerPluginId: ctx?.caller?.pluginId ?? null,
    callerKind: ctx?.caller?.kind ?? null,
    target: target ?? null,
    ...extra
  });
}
function withLog(host, action, targetOf, fn) {
  return async (raw, ctx) => {
    const params = raw ?? {};
    try {
      const out = await fn(params, ctx);
      logCall(host, action, ctx, targetOf(params), "ok");
      return out;
    } catch (err) {
      logCall(host, action, ctx, targetOf(params), "error", {
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  };
}
var src_default = {
  init(host) {
    const sessionIdOf = (p) => p?.id;
    const actions = {
      // ── server.status ──
      "server.status": {
        scope: "public",
        service: true,
        params: NO_ARGS,
        handler: withLog(host, "admin.server.status", () => void 0, () => host.lifecycle.runtime()),
        tool: {
          description: "Server \u8FD0\u884C\u72B6\u6001\uFF1A\u7248\u672C\u3001uptime\u3001\u7AEF\u53E3\u3001pid\u3001worker \u6C60\u7EDF\u8BA1\uFF08active / placeholders / max / pendingCalls\uFF09\u3002\u4E0D\u542B\u4EFB\u4F55\u51ED\u636E\u3002",
          exposure: "deferred",
          namespace: { name: "admin", instructions: "\u5E73\u53F0\u7BA1\u7406\u52A8\u4F5C\uFF08\u72B6\u6001 / agent / session\uFF09\u3002" }
        },
        http: {}
      },
      // ── agent.list ──
      "agent.list": {
        scope: "public",
        service: true,
        params: {
          type: "object",
          properties: {
            name: { type: "string", description: "name \u5B50\u4E32\uFF08\u4E0D\u533A\u5206\u5927\u5C0F\u5199\uFF09" },
            workspacePath: { type: "string", description: "workspacePath \u524D\u7F00\uFF08\u542B\u5B50\u76EE\u5F55\uFF09" },
            description: { type: "string", description: "description \u5B50\u4E32\uFF08\u4E0D\u533A\u5206\u5927\u5C0F\u5199\uFF09" }
          },
          additionalProperties: false
        },
        handler: withLog(
          host,
          "admin.agent.list",
          () => void 0,
          async (p) => {
            let rows = await host.agents.list();
            if (p.workspacePath) {
              const target = p.workspacePath.replace(/\\/g, "/").replace(/\/+$/, "");
              rows = rows.filter((a) => {
                const wp = String(a.workspacePath ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
                return wp === target || wp.startsWith(`${target}/`);
              });
            }
            if (p.name) {
              const q = p.name.toLowerCase();
              rows = rows.filter((a) => String(a.name ?? "").toLowerCase().includes(q));
            }
            if (p.description) {
              const q = p.description.toLowerCase();
              rows = rows.filter((a) => String(a.description ?? "").toLowerCase().includes(q));
            }
            return {
              agents: rows.map((a) => ({
                id: a.id,
                name: a.name,
                description: a.description,
                workspacePath: a.workspacePath,
                model: a.model,
                thinkingLevel: a.thinkingLevel
              })),
              total: rows.length
            };
          }
        ),
        tool: {
          description: "\u641C\u7D22 agents\uFF1Aname / workspacePath / description \u7EC4\u5408\u6A21\u7CCA\u8FC7\u6EE4\uFF08\u5B50\u4E32\u3001AND\uFF0C\u4E0D\u4F20=\u5168\u90E8\uFF09\u3002",
          exposure: "deferred",
          namespace: "admin"
        },
        http: {}
      },
      // ── agent.get ──
      "agent.get": {
        scope: "public",
        service: true,
        params: {
          type: "object",
          properties: { id: { type: "string", description: "agent id" } },
          required: ["id"],
          additionalProperties: false
        },
        handler: withLog(host, "admin.agent.get", sessionIdOf, async (p) => {
          const found = await host.agents.get(p.id);
          if (!found) throw new Error(`Agent not found: ${p.id}`);
          return found;
        }),
        tool: {
          description: "\u6309 id \u53D6 agent \u5B8C\u6574\u914D\u7F6E\uFF08\u542B config\uFF09\u3002",
          exposure: "deferred",
          namespace: "admin"
        },
        http: {}
      },
      // ── agent.update ──
      "agent.update": {
        scope: "public",
        service: true,
        params: {
          type: "object",
          properties: {
            id: { type: "string", description: "agent id" },
            patch: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                workspacePath: { type: "string", description: "\u5FC5\u987B\u662F\u5DF2\u5B58\u5728\u7684\u7EDD\u5BF9\u8DEF\u5F84" },
                model: { type: "string", description: "provider/modelId" },
                thinkingLevel: { type: "string", enum: ["off", "low", "medium", "high"] },
                config: { type: "object", description: "AgentConfig \u6574\u4F53\u66FF\u6362" }
              },
              additionalProperties: false
            }
          },
          required: ["id", "patch"],
          additionalProperties: false
        },
        handler: withLog(
          host,
          "admin.agent.update",
          (p) => p.id,
          async (p) => {
            const existing = await host.agents.get(p.id);
            if (!existing) throw new Error(`Agent not found: ${p.id}`);
            await host.agents.update(p.id, p.patch);
            return await host.agents.get(p.id);
          }
        ),
        tool: {
          description: "\u5C40\u90E8\u66F4\u65B0 agent \u914D\u7F6E\uFF08name/description/workspacePath/model/thinkingLevel/config\uFF09\u3002\u4EC5\u5F71\u54CD\u8BE5 agent \u672A\u6765\u65B0\u5EFA\u7684 session\u2014\u2014\u8FD0\u884C\u4E2D\u7684 session \u662F\u521B\u5EFA\u65F6\u5FEB\u7167\u3002",
          exposure: "deferred",
          namespace: "admin"
        },
        http: {}
      },
      // ── session.list ──
      "session.list": {
        scope: "public",
        service: true,
        params: {
          type: "object",
          properties: {
            agentId: { type: "string", description: "\u7CBE\u786E\u5339\u914D" },
            title: { type: "string", description: "title \u5B50\u4E32\uFF08\u4E0D\u533A\u5206\u5927\u5C0F\u5199\uFF09" },
            status: { type: "string", enum: ["active", "archived"] }
          },
          additionalProperties: false
        },
        handler: withLog(
          host,
          "admin.session.list",
          () => void 0,
          async (p) => {
            const sessions = await host.sessions.find(p);
            return { sessions, total: sessions.length };
          }
        ),
        tool: {
          description: "\u641C\u7D22 sessions\uFF1AagentId \u7CBE\u786E + title \u6A21\u7CCA + status(active|archived)\uFF0CAND \u5173\u7CFB\uFF1B\u6BCF\u9879\u542B workerAlive\u3002",
          exposure: "deferred",
          namespace: "admin"
        },
        http: {}
      },
      // ── session.get ──
      "session.get": {
        scope: "public",
        service: true,
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false
        },
        handler: withLog(host, "admin.session.get", sessionIdOf, async (p) => {
          const s = await host.sessions.detail(p.id);
          if (!s) throw new Error(`Session not found: ${p.id}`);
          return s;
        }),
        tool: {
          description: "\u6309 id \u53D6 session \u5B8C\u6574\u8BE6\u60C5\uFF08\u542B config\u3001workerAlive\uFF09\u3002",
          exposure: "deferred",
          namespace: "admin"
        },
        http: {}
      },
      // ── session.update ──
      "session.update": {
        scope: "public",
        service: true,
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
            patch: {
              type: "object",
              properties: {
                title: { type: "string", description: "1-200 \u5B57\u7B26\uFF1B\u7A7A\u4E32=\u6E05\u7A7A" },
                model: { type: "string", description: "provider/modelId\uFF08worker \u5B58\u6D3B\u65F6\u7ACB\u5373\u5207\u6362\uFF09" },
                thinkingLevel: { type: "string", enum: ["off", "low", "medium", "high"] },
                config: { type: "object", description: "AgentConfig \u6574\u4F53\u66FF\u6362\uFF1B\u26A0\uFE0F \u4E0B\u6B21 spawn \u751F\u6548" }
              },
              additionalProperties: false
            }
          },
          required: ["id", "patch"],
          additionalProperties: false
        },
        handler: withLog(
          host,
          "admin.session.update",
          (p) => p.id,
          async (p) => {
            return await host.sessions.update(p.id, p.patch);
          }
        ),
        tool: {
          description: "\u5C40\u90E8\u66F4\u65B0 session\uFF1Amodel/thinkingLevel \u5373\u65F6\u751F\u6548\u3001title \u8D70\u6539\u540D\u540C\u6B65\u3001config.* \u4EC5\u5199 DB\uFF08\u4E0B\u6B21 spawn \u751F\u6548\uFF1B\u60F3\u7ACB\u5373\u751F\u6548\u914D\u5408 session.restart\uFF09\u3002",
          exposure: "deferred",
          namespace: "admin"
        },
        http: {}
      },
      // ── session.restart ──
      "session.restart": {
        scope: "public",
        service: true,
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false
        },
        handler: withLog(
          host,
          "admin.session.restart",
          sessionIdOf,
          async (p) => host.sessions.restart(p.id)
        ),
        tool: {
          description: "\u91CD\u542F session worker\uFF1A\u4F18\u96C5 kill \u540E\u91CD\u5EFA\u5E76\u590D\u7528\u5386\u53F2\uFF08\u91CD\u65B0\u6253\u5F00\u5E76\u52A0\u8F7D\uFF09\u3002sessions \u884C\u4E0E IM/Web \u6E20\u9053\u6620\u5C04\u4E0D\u53D7\u5F71\u54CD\u3002\u7528\u4E8E\u8BA9 config.* \u4FEE\u6539\u7ACB\u5373\u751F\u6548\uFF1B\u6B63\u5728\u8DD1\u7684 turn \u4F1A\u88AB\u4E2D\u65AD\uFF08busy \u65F6\u4F1A\u88AB\u62D2\u7EDD\uFF09\u3002",
          exposure: "deferred",
          namespace: "admin"
        },
        http: {}
      }
    };
    host.actions.define(actions);
    host.http.route({
      method: "GET",
      path: "/status",
      handler: async () => ({
        json: {
          runtime: host.lifecycle.runtime(),
          counts: {
            agents: (await host.agents.list()).length,
            sessions: (await host.sessions.find()).length,
            actions: host.actions ? Object.keys(actions).length : 0
          }
        }
      })
    });
    host.ui.page({ path: "/admin-status", label: "\u5E73\u53F0\u72B6\u6001", icon: "monitor", component: "page", order: 60 });
    host.log("info", `admin: \u58F0\u660E ${Object.keys(actions).length} \u4E2A\u52A8\u4F5C\uFF08scope:public + deferred \u5DE5\u5177\uFF09`);
  }
};
export {
  src_default as default
};
