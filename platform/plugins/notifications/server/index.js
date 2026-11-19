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
    host.methods.handle("post", (params, ctx) => {
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
    });
    const FAILURE_TOPICS = [
      { topic: "scheduler.run.failed", label: (p) => `\u5B9A\u65F6\u4EFB\u52A1\u300C${p.name}\u300D\u6295\u9012\u5931\u8D25` },
      { topic: "webhook.delivery.failed", label: (p) => `Webhook\u300C${p.name}\u300D\u6295\u9012\u5931\u8D25` }
    ];
    for (const { topic, label } of FAILURE_TOPICS) {
      const off = host.bus.subscribe(topic, (raw) => {
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
    }
    host.log("info", "notifications plugin ready");
  }
};
export {
  src_default as default
};
