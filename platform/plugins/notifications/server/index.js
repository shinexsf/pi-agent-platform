const SEVERITIES = ["info", "warning", "error"];
function toDTO(row) {
  return {
    id: row.id,
    severity: row.severity,
    title: row.title,
    body: row.body,
    source: row.source,
    sourceId: row.source_id,
    actionUrl: row.action_url,
    readAt: row.read_at,
    createdAt: row.created_at
  };
}
var src_default = {
  init(host) {
    host.db.migrate(
      "notifications",
      `
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        source TEXT NOT NULL,
        source_id TEXT,
        action_url TEXT,
        read_at INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at);
      CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at);
      `
    );
    const unreadCount = () => host.db.query("SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL")[0]?.n ?? 0;
    host.ui.page({ path: "/notifications", label: "\u901A\u77E5", icon: "bell", component: "page", nav: false });
    host.ui.headerAction({
      id: "inbox",
      icon: "bell",
      title: "\u901A\u77E5",
      component: "panel",
      order: 10,
      badge: { endpoint: "/unread-count" }
    });
    host.http.route({
      method: "GET",
      path: "/",
      handler: (req) => {
        const unread = req.query.unread === "1";
        const severity = SEVERITIES.find((s) => s === req.query.severity);
        const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
        const where = [];
        const params = [];
        if (unread) where.push("read_at IS NULL");
        if (severity) {
          where.push("severity = ?");
          params.push(severity);
        }
        const sql = `SELECT * FROM notifications ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC LIMIT ?`;
        const rows = host.db.query(sql, [...params, limit]);
        return { json: { items: rows.map(toDTO), unreadCount: unreadCount() } };
      }
    });
    host.http.route({
      method: "POST",
      path: "/:id/read",
      handler: (req) => {
        const id = req.params.id ?? "";
        const changed = host.db.query("UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL", [Date.now(), id]);
        const row = host.db.query("SELECT * FROM notifications WHERE id = ?", [id])[0];
        if (!row) return { status: 404, json: { error: "notification not found" } };
        return { json: { ok: true, unreadCount: unreadCount() } };
      }
    });
    host.http.route({
      method: "GET",
      path: "/unread-count",
      handler: () => ({ json: { count: unreadCount() } })
    });
    host.http.route({
      method: "POST",
      path: "/read-all",
      handler: () => {
        const before = unreadCount();
        host.db.query("UPDATE notifications SET read_at = ? WHERE read_at IS NULL", [Date.now()]);
        return { json: { ok: true, changed: before, unreadCount: unreadCount() } };
      }
    });
    function insert(input) {
      const id = `ntf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      host.db.query(
        "INSERT INTO notifications (id, severity, title, body, source, source_id, action_url, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
        [
          id,
          input.severity ?? "info",
          input.title.slice(0, 200),
          (input.body ?? "").slice(0, 4e3),
          input.source,
          input.sourceId ?? null,
          input.actionUrl ?? null,
          Date.now()
        ]
      );
      return id;
    }
    host.actions.define({
      post: {
        scope: "own",
        params: {
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
        },
        tool: {
          description: "\u5411 server \u901A\u77E5\u4E2D\u5FC3\u53D1\u9001\u4E00\u6761\u6D88\u606F\uFF08\u5199\u8FDB\u6536\u4EF6\u7BB1\uFF0C\u4F9B\u7528\u6237\u7A0D\u540E\u67E5\u770B\uFF1B\u5E73\u53F0\u4E0D\u505A\u5916\u90E8\u63A8\u9001\uFF09",
          // direct：这是少数"模型必须随手可用"的工具（失败要能立刻汇报），
          // 藏进 tool_search 只会让失败信息留在会话里没人看见。
          exposure: "direct",
          namespace: "notifications",
          promptSnippet: "Post a message to the server notification inbox",
          promptGuidelines: [
            'Use postNotification when the result matters while the user is away \u2014 scheduled/long tasks, failures, or explicit "tell me when done" requests.',
            "Do NOT use it for ordinary replies: if the user is chatting with you, answer in the conversation.",
            "severity: info for progress, warning for something the user should look at, error for failures."
          ]
        },
        handler: (params, ctx) => {
          const p = params ?? {};
          const title = (p.title ?? "").trim();
          const body = (p.body ?? "").trim();
          if (!title && !body) throw new Error("postNotification: title/body required");
          const id = insert({
            title,
            body,
            severity: p.severity ?? "info",
            source: "agent",
            sourceId: ctx.sessionId || null,
            // 深链由平台拼，调用方（模型）给不了
            actionUrl: ctx.sessionId ? `/chat/${ctx.sessionId}` : null
          });
          return { id, unreadCount: unreadCount() };
        }
      }
    });
    const FAILURE_TOPICS = [
      { topic: "scheduler.run.failed", label: (p) => `\u5B9A\u65F6\u4EFB\u52A1\u300C${p.name}\u300D\u6295\u9012\u5931\u8D25` },
      { topic: "webhook.delivery.failed", label: (p) => `Webhook\u300C${p.name}\u300D\u6295\u9012\u5931\u8D25` }
    ];
    host.bus.declare("notifications.notify", { declaredBy: "subscriber" });
    for (const { topic, label } of FAILURE_TOPICS) {
      const sub = host.bus.subscribe(topic, (raw) => {
        const p = raw ?? {};
        insert({
          title: label(p),
          body: p.reason ?? "",
          severity: "error",
          source: p.source ?? topic.split(".")[0] ?? "plugin",
          sourceId: p.taskId ?? p.hookId ?? null,
          actionUrl: p.actionUrl ?? null
        });
      });
      if (sub.state === "pending") {
        host.log("debug", `waiting for topic ${topic} to be declared (producer not loaded yet)`);
      }
    }
    host.log("info", "notifications plugin ready");
  }
};
export {
  src_default as default
};
