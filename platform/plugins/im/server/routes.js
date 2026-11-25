function json(data, status = 200) {
  return status === 200 ? { json: data } : { status, json: data };
}
function registerRoutes(http, gateway) {
  http({
    method: "GET",
    path: "/connections",
    handler: () => json({
      channels: gateway.listChannels(),
      connections: gateway.listConnections()
    })
  });
  http({
    method: "PATCH",
    path: "/connections/:id",
    handler: async (req) => {
      const id = req.params.id ?? "";
      let patch = {};
      try {
        patch = JSON.parse(req.body || "{}");
      } catch {
        return json({ error: "body \u4E0D\u662F\u5408\u6CD5 JSON" }, 400);
      }
      try {
        if (typeof patch.enabled === "boolean") await gateway.setConnectionEnabled(id, patch.enabled);
        if (typeof patch.agentId === "string") gateway.setConnectionAgent(id, patch.agentId);
        if (patch.defaultSessionId !== void 0) {
          await gateway.setDefaultSession(id, patch.defaultSessionId || null);
        }
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
      return json({ ok: true, connection: gateway.listConnections().find((c) => c.id === id) ?? null });
    }
  });
  http({
    method: "DELETE",
    path: "/connections/:id",
    handler: async (req) => {
      const result = await gateway.removeConnection(req.params.id ?? "");
      return result.ok ? json({ ok: true }) : json({ error: result.reason ?? "remove failed" }, 409);
    }
  });
  http({
    method: "GET",
    path: "/bindings",
    handler: (req) => json({ bindings: gateway.listBindings(req.query.connectionId ? { connectionId: req.query.connectionId } : void 0) })
  });
  http({
    method: "PATCH",
    path: "/bindings/:connectionId/:chatId",
    handler: async (req) => {
      let body = {};
      try {
        body = JSON.parse(req.body || "{}");
      } catch {
        return json({ error: "body \u4E0D\u662F\u5408\u6CD5 JSON" }, 400);
      }
      const sessionId = (body.sessionId ?? "").trim();
      if (!sessionId) return json({ error: "sessionId \u5FC5\u586B" }, 400);
      const result = await gateway.bind(
        req.params.connectionId ?? "",
        decodeURIComponent(req.params.chatId ?? ""),
        sessionId
      );
      return result.ok ? json({ ok: true }) : json({ error: result.reason ?? "bind failed" }, 400);
    }
  });
  http({
    method: "DELETE",
    path: "/bindings/:connectionId/:chatId",
    handler: async (req) => {
      const removed = await gateway.unbind(req.params.connectionId ?? "", decodeURIComponent(req.params.chatId ?? ""));
      return removed ? json({ ok: true }) : json({ error: "binding not found" }, 404);
    }
  });
  http({
    method: "GET",
    path: "/events",
    handler: () => {
      const encoder = new TextEncoder();
      let unsubscribe;
      let heartbeat;
      const stream = new ReadableStream({
        start(controller) {
          const write = (event, data) => {
            try {
              controller.enqueue(encoder.encode(`event: ${event}
data: ${JSON.stringify(data)}

`));
            } catch {
            }
          };
          for (const entry of gateway.recentLogs()) write("channel-log", entry);
          unsubscribe = gateway.onLog((entry) => write("channel-log", entry));
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
            }
          }, 15e3);
        },
        cancel() {
          unsubscribe?.();
          if (heartbeat) clearInterval(heartbeat);
        }
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive"
        }
      });
    }
  });
}
export {
  registerRoutes
};
