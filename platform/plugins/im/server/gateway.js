import { createSessionProjector } from "@pi-agent-platform/event-projection";
import {
  CHANNEL_API_VERSION,
  CHANNEL_NAMESPACE
} from "./channel-api.js";
import { bindingKey } from "./state.js";
const LOG_RING = 200;
const inboundChains = /* @__PURE__ */ new Map();
function createGateway(deps) {
  const { host, state } = deps;
  const channels = /* @__PURE__ */ new Map();
  const replies = /* @__PURE__ */ new Map();
  const logListeners = /* @__PURE__ */ new Set();
  const logRing = [];
  const attaching = /* @__PURE__ */ new Set();
  let disposed = false;
  function log(level, message, extra) {
    host.log(level, message, extra);
  }
  function emitLog(level, message, extra) {
    const entry = { timestamp: Date.now(), level, message, ...extra };
    logRing.push(entry);
    if (logRing.length > LOG_RING) logRing.shift();
    for (const listener of logListeners) {
      try {
        listener(entry);
      } catch {
      }
    }
  }
  function ownerOf(connectionId) {
    for (const entry of channels.values()) {
      if (entry.connections.has(connectionId)) return entry;
    }
    return void 0;
  }
  function declareConnection(providerId, meta) {
    const entry = channels.get(providerId);
    if (!entry) return;
    if (typeof meta?.id !== "string" || !meta.id) {
      log("warn", "declare \u6536\u5230\u975E\u6CD5\u8FDE\u63A5\u5143\u4FE1\u606F", { providerId, meta });
      return;
    }
    if (entry.connections.has(meta.id)) return;
    entry.connections.add(meta.id);
    state.ensureConnection(meta.id);
    emitLog("info", `\u8FDE\u63A5\u5DF2\u767B\u8BB0\uFF1A${meta.label || meta.id}`, { providerId, connectionId: meta.id });
  }
  function retireLocal(entry, connectionId) {
    entry.connections.delete(connectionId);
    for (const [key] of state.bindingsOfConnection(connectionId)) {
      state.removeBinding(connectionId, key.slice(key.indexOf("|") + 1));
    }
    state.removeConnection(connectionId);
  }
  function makeUplink(providerId) {
    return {
      declare: (meta) => declareConnection(providerId, meta),
      retire: (connectionId) => {
        const entry = channels.get(providerId);
        if (!entry) return;
        retireLocal(entry, connectionId);
        emitLog("info", "\u8FDE\u63A5\u5DF2\u79FB\u9664", { providerId, connectionId });
        releaseOfflineSubscriptions();
      },
      onInbound: (msg) => handleInbound(providerId, msg),
      onStatus: (evt) => handleStatus(providerId, evt.connectionId, evt.status, evt.error)
    };
  }
  function handleStatus(providerId, connectionId, status, error) {
    const entry = channels.get(providerId);
    if (!entry || !entry.connections.has(connectionId)) return;
    state.updateConnection(connectionId, { status, ...error ? { lastError: error } : {} });
    emitLog(status === "error" ? "error" : "info", `\u8FDE\u63A5\u72B6\u6001\uFF1A${status}${error ? `\uFF08${error}\uFF09` : ""}`, {
      providerId,
      connectionId
    });
    if (status !== "connected") releaseOfflineSubscriptions();
  }
  async function attach(providerId, serviceName) {
    if (channels.has(providerId) || attaching.has(providerId)) return;
    attaching.add(providerId);
    try {
      const raw = await host.services.call(serviceName, { uplink: makeUplink(providerId) });
      const driver = raw;
      if (!driver || typeof driver !== "object") {
        log("warn", "\u6E20\u9053\u6CA1\u6709\u8FD4\u56DE driver", { providerId, serviceName });
        return;
      }
      if (driver.apiVersion !== CHANNEL_API_VERSION) {
        log("warn", "\u6E20\u9053\u5951\u7EA6\u7248\u672C\u4E0D\u5339\u914D\uFF0C\u5DF2\u8DF3\u8FC7", { providerId, got: driver.apiVersion, want: CHANNEL_API_VERSION });
        return;
      }
      const entry = {
        providerId,
        serviceName,
        driver,
        connections: /* @__PURE__ */ new Set()
      };
      channels.set(providerId, entry);
      log("info", "\u6E20\u9053\u5DF2\u63A5\u5165", { providerId, type: driver.type, label: driver.label });
      for (const meta of driver.connections() ?? []) declareConnection(providerId, meta);
      for (const connectionId of entry.connections) {
        if (!state.ensureConnection(connectionId).enabled) continue;
        await connectOne(providerId, connectionId);
      }
    } catch (err) {
      log("warn", "\u6E20\u9053\u63A5\u5165\u5931\u8D25", { providerId, err: String(err) });
      state.updateConnection(providerId, { status: "error", lastError: String(err) });
    } finally {
      attaching.delete(providerId);
    }
  }
  async function connectOne(providerId, connectionId) {
    const entry = channels.get(providerId);
    if (!entry) return;
    try {
      await entry.driver.connect(connectionId);
      emitLog("info", "\u5DF2\u53D1\u8D77\u8FDE\u63A5", { providerId, connectionId });
    } catch (err) {
      state.updateConnection(connectionId, { status: "error", lastError: String(err) });
      emitLog("error", `\u8FDE\u63A5\u5931\u8D25\uFF1A${String(err)}`, { providerId, connectionId });
    }
  }
  async function disconnectOne(providerId, connectionId) {
    const entry = channels.get(providerId);
    if (!entry) return;
    try {
      await entry.driver.disconnect(connectionId);
    } catch (err) {
      log("warn", "\u65AD\u5F00\u8FDE\u63A5\u5931\u8D25\uFF08\u7EE7\u7EED\u6458\u9664\uFF09", { providerId, connectionId, err: String(err) });
    }
    emitLog("info", "\u5DF2\u65AD\u5F00\u8FDE\u63A5", { providerId, connectionId });
  }
  async function detach(providerId) {
    const entry = channels.get(providerId);
    if (!entry) return;
    channels.delete(providerId);
    for (const connectionId of entry.connections) state.updateConnection(connectionId, { status: "disconnected" });
    log("info", "\u6E20\u9053\u5DF2\u6458\u9664", { providerId });
    releaseOfflineSubscriptions();
  }
  async function rescan() {
    if (disposed) return;
    let services = [];
    try {
      services = host.services.list({ namespace: CHANNEL_NAMESPACE });
    } catch (err) {
      log("warn", "\u670D\u52A1\u76EE\u5F55\u67E5\u8BE2\u5931\u8D25", { err: String(err) });
      return;
    }
    const present = new Set(services.map((s) => s.owner));
    for (const svc of services) {
      if (channels.has(svc.owner) || attaching.has(svc.owner)) continue;
      await attach(svc.owner, svc.name);
    }
    for (const providerId of [...channels.keys()]) {
      if (present.has(providerId)) continue;
      await detach(providerId);
    }
    if (services.length === 0) {
      log("debug", "\u5F53\u524D\u6CA1\u6709\u4EFB\u4F55 IM \u6E20\u9053\uFF08namespace im.channel \u4E3A\u7A7A\uFF09", { namespace: CHANNEL_NAMESPACE });
    }
  }
  async function handleInbound(providerId, msg) {
    const entry = channels.get(providerId);
    if (!entry) {
      log("warn", "\u6536\u5230\u672A\u77E5\u6E20\u9053\u7684\u5165\u7AD9\u6D88\u606F", { providerId });
      return;
    }
    if (!entry.connections.has(msg.connectionId)) {
      log("warn", "\u6536\u5230\u672A\u77E5\u8FDE\u63A5\u7684\u5165\u7AD9\u6D88\u606F", { providerId, connectionId: msg.connectionId });
      return;
    }
    const key = `${providerId}|${msg.connectionId}|${msg.chatId}`;
    const previous = inboundChains.get(key) ?? Promise.resolve();
    const next = previous.then(() => routeInbound(entry, msg)).catch((err) => {
      log("warn", "\u5165\u7AD9\u5904\u7406\u5931\u8D25", { providerId, connectionId: msg.connectionId, err: String(err) });
    });
    inboundChains.set(key, next);
    await next;
  }
  async function routeInbound(entry, msg) {
    const connection = state.ensureConnection(msg.connectionId);
    const agentId = connection.agentId;
    if (!agentId) {
      await entry.driver.send(msg.connectionId, msg.chatId, {
        text: "\u8FD9\u6761\u8FDE\u63A5\u8FD8\u6CA1\u6709\u7ED1\u5B9A agent\uFF08\u5728 IM \u7F51\u5173\u9875\u9762\u91CC\u8BBE\u7F6E\u540E\u518D\u8BD5\uFF09\u3002"
      });
      return;
    }
    const command = parseCommand(msg.text);
    let existing = state.getBinding(msg.connectionId, msg.chatId)?.sessionId;
    const viaDefault = !existing;
    if (!existing && connection.defaultSessionId) {
      const detail = await host.sessions.detail(connection.defaultSessionId);
      if (detail && detail.agentId === agentId) {
        existing = connection.defaultSessionId;
      } else {
        log("warn", "\u8FDE\u63A5\u9ED8\u8BA4\u4F1A\u8BDD\u4E0D\u53EF\u7528\uFF08\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u5C5E\u4E8E\u522B\u7684 agent\uFF09\uFF0C\u6309\u81EA\u52A8\u65B0\u5EFA\u5904\u7406", {
          connectionId: msg.connectionId,
          defaultSessionId: connection.defaultSessionId
        });
      }
    }
    if (command?.name === "new") {
      const created = await host.sessions.ensure({ agentId, title: `IM \xB7 ${entry.driver.label}` });
      state.setBinding(msg.connectionId, msg.chatId, created.sessionId);
      await entry.driver.send(msg.connectionId, msg.chatId, {
        text: `\u5DF2\u65B0\u5EFA\u4F1A\u8BDD\uFF08${created.sessionId.slice(0, 8)}\uFF09`
      });
      emitLog("info", "\u5DF2\u6309 /new \u65B0\u5EFA\u4F1A\u8BDD", { providerId: entry.providerId, connectionId: msg.connectionId });
      return;
    }
    let reusable = existing;
    if (reusable) {
      const detail = await host.sessions.detail(reusable);
      if (!detail || detail.agentId !== agentId) reusable = void 0;
    }
    const ensured = await host.sessions.ensure({
      agentId,
      sessionId: reusable,
      title: `IM \xB7 ${entry.driver.label}`
    });
    if (ensured.sessionId !== state.getBinding(msg.connectionId, msg.chatId)?.sessionId) {
      state.setBinding(msg.connectionId, msg.chatId, ensured.sessionId);
      if (viaDefault && existing) {
        emitLog("info", "\u6309\u8FDE\u63A5\u9ED8\u8BA4\u4F1A\u8BDD\u8DEF\u7531\u5E76\u56FA\u5316\u7ED1\u5B9A", {
          providerId: entry.providerId,
          connectionId: msg.connectionId
        });
      }
    }
    const attachments = [];
    for (const att of msg.attachments ?? []) {
      try {
        const saved = await host.attachments.upload({
          sessionId: ensured.sessionId,
          bytes: att.bytes,
          mimeType: att.mimeType,
          filename: att.filename
        });
        attachments.push(saved);
      } catch (err) {
        log("warn", "\u9644\u4EF6\u4E0A\u4F20\u5931\u8D25", { sessionId: ensured.sessionId, err: String(err) });
      }
    }
    const text = msg.text?.trim() || (attachments.length > 0 ? "[\u7528\u6237\u53D1\u6765\u9644\u4EF6]" : "");
    if (!text) return;
    ensureReplySubscription(ensured.sessionId);
    if (command && command.name !== "new") {
      try {
        await host.sessions.call(ensured.sessionId, "dispatchCommand", [command.name, command.args]);
        emitLog("info", `\u5DF2\u6267\u884C\u547D\u4EE4 /${command.name}`, { providerId: entry.providerId, connectionId: msg.connectionId });
        return;
      } catch (err) {
        log("debug", "\u547D\u4EE4\u5206\u53D1\u5931\u8D25\uFF0C\u6309\u666E\u901A\u6D88\u606F\u5904\u7406", { command: command.name, err: String(err) });
      }
    }
    await host.sessions.call(ensured.sessionId, "prompt", [
      text,
      attachments.length > 0 ? { attachments } : void 0
    ]);
    emitLog("info", "\u5DF2\u6295\u9012\u5230\u4F1A\u8BDD", { providerId: entry.providerId, connectionId: msg.connectionId });
  }
  function parseCommand(text) {
    if (typeof text !== "string") return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;
    const [head, ...rest] = trimmed.slice(1).split(/\s+/);
    if (!head) return null;
    return { name: head.toLowerCase(), args: rest.join(" ") };
  }
  function ensureReplySubscription(sessionId) {
    if (replies.has(sessionId)) return;
    const projector = createSessionProjector();
    const entry = { dispose: () => {
    }, projector, pending: null };
    const dispose = host.sessions.subscribe(
      sessionId,
      (raw) => {
        const evt = raw;
        if (evt?.kind !== "event") return;
        let projected;
        try {
          projected = projector.project(evt);
        } catch {
          return;
        }
        if (!projected) return;
        const dto = projected.data;
        if (!dto?.messageId) return;
        if (dto.role && dto.role !== "assistant") return;
        if (projected.name === "message_update") {
          entry.pending = { messageId: dto.messageId, text: dto.content ?? "", done: false };
          return;
        }
        if (projected.name !== "message_end") return;
        const pending = entry.pending;
        if (!pending || pending.messageId !== dto.messageId || pending.done) return;
        pending.done = true;
        entry.pending = null;
        if (Array.isArray(dto.toolCalls) && dto.toolCalls.length > 0) return;
        const text = pending.text.trim();
        if (!text) return;
        void deliver(sessionId, text);
      },
      () => {
        replies.delete(sessionId);
      }
    );
    entry.dispose = dispose;
    replies.set(sessionId, entry);
  }
  async function deliver(sessionId, text) {
    for (const [key, binding] of Object.entries(state.get().bindings)) {
      if (binding.sessionId !== sessionId) continue;
      const { connectionId, chatId } = splitKey(key);
      const entry = ownerOf(connectionId);
      if (!entry) continue;
      if (state.get().connections[connectionId]?.status !== "connected") continue;
      try {
        await entry.driver.send(connectionId, chatId, { text });
        emitLog("info", "\u5DF2\u6295\u9012\u56DE\u590D", { providerId: entry.providerId, connectionId });
      } catch (err) {
        emitLog("error", `\u56DE\u590D\u6295\u9012\u5931\u8D25\uFF1A${String(err)}`, { providerId: entry.providerId, connectionId });
      }
    }
  }
  function releaseOfflineSubscriptions() {
    const bindings = state.get().bindings;
    const connections = state.get().connections;
    for (const [sessionId, sub] of [...replies.entries()]) {
      const related = Object.entries(bindings).filter(([, b]) => b.sessionId === sessionId);
      if (related.length === 0) {
        sub.dispose();
        replies.delete(sessionId);
        continue;
      }
      const anyOnline = related.some(([key]) => {
        const status = connections[splitKey(key).connectionId]?.status;
        return status === "connected" || status === "unknown";
      });
      if (anyOnline) continue;
      sub.dispose();
      replies.delete(sessionId);
      const firstKey = related[0]?.[0];
      emitLog("info", "\u8FDE\u63A5\u5168\u90E8\u4E0B\u7EBF\uFF0C\u4F1A\u8BDD\u8BA2\u9605\u5DF2\u91CA\u653E", {
        ...firstKey ? { connectionId: splitKey(firstKey).connectionId } : {}
      });
    }
  }
  function listConnections() {
    const out = [];
    for (const entry of channels.values()) {
      for (const connectionId of entry.connections) {
        const st = state.get().connections[connectionId] ?? {
          enabled: true,
          status: "unknown",
          updatedAt: 0
        };
        out.push({
          id: connectionId,
          providerId: entry.providerId,
          type: entry.driver.type,
          label: entry.driver.label,
          enabled: st.enabled,
          status: st.status,
          canRemove: typeof entry.driver.remove === "function",
          ...st.lastError ? { lastError: st.lastError } : {},
          ...st.agentId ? { agentId: st.agentId } : {},
          ...st.defaultSessionId ? { defaultSessionId: st.defaultSessionId } : {},
          bindings: state.bindingsOfConnection(connectionId).map(([key, b]) => ({
            chatId: splitKey(key).chatId,
            sessionId: b.sessionId,
            updatedAt: b.updatedAt
          }))
        });
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }
  return {
    listConnections,
    listChannels: () => [...channels.values()].map((entry) => ({
      providerId: entry.providerId,
      type: entry.driver.type,
      label: entry.driver.label,
      connections: entry.connections.size,
      canSendFile: typeof entry.driver.sendFile === "function"
    })),
    async setConnectionEnabled(connectionId, enabled) {
      const entry = ownerOf(connectionId);
      if (!entry) throw new Error(`\u672A\u77E5\u8FDE\u63A5\uFF1A${connectionId}`);
      state.updateConnection(connectionId, { enabled });
      if (enabled) await connectOne(entry.providerId, connectionId);
      else {
        await disconnectOne(entry.providerId, connectionId);
        state.updateConnection(connectionId, { status: "disconnected" });
        releaseOfflineSubscriptions();
      }
    },
    setConnectionAgent(connectionId, agentId) {
      const entry = ownerOf(connectionId);
      if (!entry) throw new Error(`\u672A\u77E5\u8FDE\u63A5\uFF1A${connectionId}`);
      if (!host.agents.get(agentId)) throw new Error(`\u672A\u77E5 agent\uFF1A${agentId}`);
      const previous = state.get().connections[connectionId]?.agentId;
      state.updateConnection(connectionId, { agentId });
      if (previous && previous !== agentId) {
        for (const [key] of state.bindingsOfConnection(connectionId)) {
          state.removeBinding(connectionId, key.slice(key.indexOf("|") + 1));
        }
        state.updateConnection(connectionId, { defaultSessionId: void 0 });
        releaseOfflineSubscriptions();
      }
    },
    async setDefaultSession(connectionId, sessionId) {
      const entry = ownerOf(connectionId);
      if (!entry) throw new Error(`\u672A\u77E5\u8FDE\u63A5\uFF1A${connectionId}`);
      if (sessionId) {
        const agentId = state.get().connections[connectionId]?.agentId;
        if (!agentId) throw new Error("\u5148\u7ED9\u8FD9\u6761\u8FDE\u63A5\u6307\u5B9A agent\uFF0C\u518D\u9009\u9ED8\u8BA4\u4F1A\u8BDD");
        const detail = await host.sessions.detail(sessionId);
        if (!detail) throw new Error(`\u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF1A${sessionId}`);
        if (detail.agentId !== agentId) throw new Error("\u8BE5\u4F1A\u8BDD\u4E0D\u5C5E\u4E8E\u8FD9\u6761\u8FDE\u63A5\u7684 agent");
        state.updateConnection(connectionId, { defaultSessionId: sessionId });
      } else {
        state.updateConnection(connectionId, { defaultSessionId: void 0 });
      }
    },
    async removeConnection(connectionId) {
      const entry = ownerOf(connectionId);
      if (!entry) return { ok: false, reason: `\u672A\u77E5\u8FDE\u63A5\uFF1A${connectionId}` };
      if (typeof entry.driver.remove !== "function") {
        return {
          ok: false,
          reason: "\u8BE5\u6E20\u9053\u6CA1\u6709\u63D0\u4F9B\u5220\u9664\u80FD\u529B\uFF0C\u8BF7\u624B\u5DE5\u4FEE\u6539\u5B83\u7684\u914D\u7F6E\u6587\u4EF6\u540E\u518D\u5237\u65B0"
        };
      }
      try {
        await entry.driver.disconnect(connectionId).catch(() => void 0);
        await entry.driver.remove(connectionId);
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      retireLocal(entry, connectionId);
      releaseOfflineSubscriptions();
      emitLog("info", "\u5DF2\u5220\u9664\u8FDE\u63A5", { providerId: entry.providerId, connectionId });
      return { ok: true };
    },
    listBindings(filter) {
      const out = [];
      for (const [key, binding] of Object.entries(state.get().bindings)) {
        const { connectionId, chatId } = splitKey(key);
        if (filter?.connectionId && connectionId !== filter.connectionId) continue;
        out.push({ connectionId, chatId, sessionId: binding.sessionId, updatedAt: binding.updatedAt });
      }
      return out.sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async unbind(connectionId, chatId) {
      const removed = state.removeBinding(connectionId, chatId);
      if (removed) releaseOfflineSubscriptions();
      return removed;
    },
    async bind(connectionId, chatId, sessionId) {
      const entry = ownerOf(connectionId);
      if (!entry) return { ok: false, reason: `\u672A\u77E5\u8FDE\u63A5\uFF1A${connectionId}` };
      const detail = await host.sessions.detail(sessionId);
      if (!detail) return { ok: false, reason: `\u4F1A\u8BDD\u4E0D\u5B58\u5728\uFF1A${sessionId}` };
      const agentId = state.get().connections[connectionId]?.agentId;
      if (agentId && detail.agentId && detail.agentId !== agentId) {
        return { ok: false, reason: "\u8BE5\u4F1A\u8BDD\u5C5E\u4E8E\u53E6\u4E00\u4E2A agent\uFF0C\u5148\u628A\u8FDE\u63A5\u7684 agent \u6539\u8FC7\u53BB\u518D\u7ED1" };
      }
      state.setBinding(connectionId, chatId, sessionId);
      ensureReplySubscription(sessionId);
      return { ok: true };
    },
    onLog(listener) {
      logListeners.add(listener);
      return () => logListeners.delete(listener);
    },
    recentLogs: () => [...logRing],
    async sendFileToSession(sessionId, input) {
      const targets = Object.entries(state.get().bindings).filter(([, b]) => b.sessionId === sessionId).map(([key]) => key);
      if (targets.length === 0) return { ok: false, reason: "\u8FD9\u4E2A\u4F1A\u8BDD\u6CA1\u6709\u7ED1\u5B9A\u4EFB\u4F55 IM \u804A\u5929" };
      let sent = 0;
      const reasons = [];
      for (const key of targets) {
        const { connectionId, chatId } = splitKey(key);
        const entry = ownerOf(connectionId);
        if (!entry) continue;
        try {
          if (typeof entry.driver.sendFile === "function") {
            await entry.driver.sendFile(connectionId, chatId, input);
          } else {
            await entry.driver.send(connectionId, chatId, {
              text: `${input.caption ? `${input.caption}
` : ""}${input.filePath}`
            });
          }
          sent += 1;
        } catch (err) {
          reasons.push(String(err));
        }
      }
      if (sent === 0) return { ok: false, reason: reasons.join("; ") || "\u6CA1\u6709\u5728\u7EBF\u8FDE\u63A5" };
      return { ok: true };
    },
    rescan,
    async dispose() {
      disposed = true;
      for (const sub of replies.values()) sub.dispose();
      replies.clear();
      logListeners.clear();
      await state.flush();
    }
  };
}
function splitKey(key) {
  const idx = key.indexOf("|");
  return idx < 0 ? { connectionId: key, chatId: "" } : { connectionId: key.slice(0, idx), chatId: key.slice(idx + 1) };
}
export {
  bindingKey,
  createGateway
};
