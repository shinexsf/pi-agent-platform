import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
function emptyState() {
  return { connections: {}, bindings: {} };
}
function bindingKey(connectionId, chatId) {
  return `${connectionId}|${chatId}`;
}
function createStateStore(dataDir, log) {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "state.json");
  let state = emptyState();
  try {
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    state = {
      connections: parsed.connections && typeof parsed.connections === "object" ? parsed.connections : {},
      bindings: parsed.bindings && typeof parsed.bindings === "object" ? parsed.bindings : {}
    };
  } catch (err) {
    if (err.code !== "ENOENT") {
      log("warn", "state.json \u8BFB\u53D6\u5931\u8D25\uFF0C\u6309\u7A7A\u72B6\u6001\u542F\u52A8", { file, err: String(err) });
    }
  }
  let chain = Promise.resolve();
  function persist() {
    const snapshot = JSON.stringify(state, null, 2);
    chain = chain.then(() => {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, snapshot, "utf8");
      renameSync(tmp, file);
    }).catch((err) => log("warn", "state.json \u5199\u5165\u5931\u8D25", { file, err: String(err) }));
    return chain;
  }
  return {
    file,
    get: () => state,
    ensureConnection(id) {
      const existing = state.connections[id];
      if (existing) return existing;
      const created = { enabled: true, status: "unknown", updatedAt: Date.now() };
      state.connections[id] = created;
      void persist();
      return created;
    },
    updateConnection(id, patch) {
      const current = state.connections[id] ?? { enabled: true, status: "unknown", updatedAt: 0 };
      state.connections[id] = { ...current, ...patch, updatedAt: Date.now() };
      void persist();
    },
    removeConnection(id) {
      delete state.connections[id];
      for (const key of Object.keys(state.bindings)) {
        if (key.startsWith(`${id}|`)) delete state.bindings[key];
      }
      void persist();
    },
    getBinding: (connectionId, chatId) => state.bindings[bindingKey(connectionId, chatId)],
    setBinding(connectionId, chatId, sessionId) {
      state.bindings[bindingKey(connectionId, chatId)] = { sessionId, updatedAt: Date.now() };
      void persist();
    },
    removeBinding(connectionId, chatId) {
      const key = bindingKey(connectionId, chatId);
      if (!(key in state.bindings)) return false;
      delete state.bindings[key];
      void persist();
      return true;
    },
    bindingsOfConnection(id) {
      return Object.entries(state.bindings).filter(([key]) => key.startsWith(`${id}|`));
    },
    flush: () => persist()
  };
}
export {
  bindingKey,
  createStateStore,
  emptyState
};
