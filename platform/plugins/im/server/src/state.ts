/**
 * 网关状态文件（`<host.dataDir>/state.json`）。
 *
 * 为什么是文件而不是表：连接凭据归各渠道的 `config.json`，网关这边只剩"启用没启用、
 * 走哪个 agent、哪个聊天接了哪个会话"——量小、无查询需求、坏了也不至于不可恢复。
 *
 * 三条硬约定（spec `im-gateway-plugin`）：
 * - **原子写**：写 `state.json.tmp` → `rename`，避免半截文件
 * - **单写队列**：同一进程内串行化，避免两次写交叉
 * - **损坏降级**：读失败 → 空状态 + warn，不崩（空绑定 = 下条消息开新会话）
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type ConnectionStatus = 'unknown' | 'connected' | 'disconnected' | 'error';

export interface ConnectionState {
  /** 是否启用（归网关：渠道的 config.json 里没有这个字段）。 */
  enabled: boolean;
  /** 该连接的默认 agent（连接 → agent → 会话）。 */
  agentId?: string;
  /**
   * 该连接的**默认会话**：未单独绑定的聊天一律路由到这里。
   *
   * 存在的理由：第一次绑定不该被迫"先发一条消息把会话创建出来"。为空 = 老行为
   * （按 chat 自动新建）。
   */
  defaultSessionId?: string;
  status: ConnectionStatus;
  lastError?: string;
  /** 最近一次状态变化（仅观测用，不参与判断）。 */
  updatedAt: number;
}

export interface BindingState {
  sessionId: string;
  updatedAt: number;
}

export interface GatewayState {
  connections: Record<string, ConnectionState>;
  /** key = `<connectionId>|<chatId>`。 */
  bindings: Record<string, BindingState>;
}

export function emptyState(): GatewayState {
  return { connections: {}, bindings: {} };
}

/** 绑定 key：连接与聊天必须一起定位（不同连接的同名 chatId 是两个人）。 */
export function bindingKey(connectionId: string, chatId: string): string {
  return `${connectionId}|${chatId}`;
}

export interface StateStore {
  readonly file: string;
  get(): GatewayState;
  /** 列一条连接（不存在则建，默认启用）。 */
  ensureConnection(id: string): ConnectionState;
  updateConnection(id: string, patch: Partial<Omit<ConnectionState, 'updatedAt'>>): void;
  removeConnection(id: string): void;
  getBinding(connectionId: string, chatId: string): BindingState | undefined;
  setBinding(connectionId: string, chatId: string, sessionId: string): void;
  removeBinding(connectionId: string, chatId: string): boolean;
  bindingsOfConnection(id: string): Array<[string, BindingState]>;
  /** 显式落盘（内部写操作会自动调；测试/退出时用）。 */
  flush(): Promise<void>;
}

export function createStateStore(
  dataDir: string,
  log: (level: 'warn' | 'info', msg: string, extra?: Record<string, unknown>) => void,
): StateStore {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'state.json');

  let state = emptyState();
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<GatewayState>;
    state = {
      connections: parsed.connections && typeof parsed.connections === 'object' ? parsed.connections : {},
      bindings: parsed.bindings && typeof parsed.bindings === 'object' ? parsed.bindings : {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      // 坏文件不阻断启动：空状态的可观测后果只是"下条消息开新会话"。
      log('warn', 'state.json 读取失败，按空状态启动', { file, err: String(err) });
    }
  }

  // 单写队列：写盘串行化（并发写会让 tmp 文件互相覆盖）。
  let chain: Promise<void> = Promise.resolve();
  function persist(): Promise<void> {
    const snapshot = JSON.stringify(state, null, 2);
    chain = chain
      .then(() => {
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, snapshot, 'utf8');
        renameSync(tmp, file);
      })
      .catch((err) => log('warn', 'state.json 写入失败', { file, err: String(err) }));
    return chain;
  }

  return {
    file,
    get: () => state,
    ensureConnection(id) {
      const existing = state.connections[id];
      if (existing) return existing;
      // 无记录 = 启用（首次见到就该连上，不需要用户先点一下）。
      const created: ConnectionState = { enabled: true, status: 'unknown', updatedAt: Date.now() };
      state.connections[id] = created;
      void persist();
      return created;
    },
    updateConnection(id, patch) {
      const current = state.connections[id] ?? { enabled: true, status: 'unknown' as ConnectionStatus, updatedAt: 0 };
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
    flush: () => persist(),
  };
}
