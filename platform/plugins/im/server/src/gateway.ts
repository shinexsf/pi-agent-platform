/**
 * IM 网关核心：渠道发现 / 连接注册表 / 会话绑定 / 回复管线 / 会话订阅管理。
 *
 * 归属判据（spec `im-gateway-plugin`）：把它 `enabled:false` 之后平台仍能建 agent、
 * 开会话、聊完一轮 —— 所以它是插件，不是内核。这里对**具体渠道零知识**：只认
 * `im.channel` 这个 namespace 上的 service 与 `ChannelDriver` 形状（那份形状在
 * `channel-api.ts` 里，也属于这份协议包，不是平台契约）。
 *
 * 三层职责：
 *   1. **发现**：快照 `services.list({ namespace })` + 插件级事件 `__core__.plugin.*`（低频）
 *   2. **投递**：入站消息 → 会话；会话事件 → 过滤聚合 → 渠道
 *   3. **状态**：连接启用/绑定/在线状态落 `state.json`；全下线则释放会话订阅
 */

import { createSessionProjector } from '@pi-agent-platform/event-projection';
import type { PluginServerHost } from '@pi-agent-platform/plugin-types';
import {
  CHANNEL_API_VERSION,
  CHANNEL_NAMESPACE,
  type ChannelDriver,
  type ChannelStatus,
  type ConnectionMeta,
  type ImUplink,
  type InboundMessage,
} from './channel-api.js';
import { bindingKey, type ConnectionState, type StateStore } from './state.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** 渠道日志条目（网关页的实时 feed；不进结构化日志，避免刷屏）。 */
export interface ChannelLogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  providerId?: string;
  connectionId?: string;
  message: string;
}

interface ChannelEntry {
  providerId: string;
  serviceName: string;
  driver: ChannelDriver;
  connections: Set<string>;
}

interface PendingMessage {
  messageId: string;
  text: string;
  done: boolean;
}

interface ReplySubscription {
  dispose: () => void;
  projector: ReturnType<typeof createSessionProjector>;
  pending: PendingMessage | null;
}

export interface Gateway {
  /** 聚合视图（网关页 / `GET /connections`）。 */
  listConnections(): Array<{
    id: string;
    providerId: string;
    type: string;
    label: string;
    enabled: boolean;
    status: ChannelStatus | 'unknown';
    lastError?: string;
    agentId?: string;
    /** 连接级默认会话（未单独绑定的聊天走它）；为空 = 按 chat 自动新建。 */
    defaultSessionId?: string;
    /** 渠道实现了 `remove` → 页面显示"删除"；否则禁用并给原因。 */
    canRemove: boolean;
    bindings: Array<{ chatId: string; sessionId: string; updatedAt: number }>;
  }>;
  /** 已 attach 的渠道（含能力位）。 */
  listChannels(): Array<{ providerId: string; type: string; label: string; connections: number; canSendFile: boolean }>;
  setConnectionEnabled(connectionId: string, enabled: boolean): Promise<void>;
  setConnectionAgent(connectionId: string, agentId: string): void;
  /** 设/清连接级默认会话（`null` = 清除）。 */
  setDefaultSession(connectionId: string, sessionId: string | null): Promise<void>;
  /** 删除连接：先让渠道删自己的配置，再 retire + 清绑定。 */
  removeConnection(connectionId: string): Promise<{ ok: boolean; reason?: string }>;
  listBindings(filter?: { connectionId?: string }): Array<{ connectionId: string; chatId: string; sessionId: string; updatedAt: number }>;
  unbind(connectionId: string, chatId: string): Promise<boolean>;
  /** 把某个聊天**显式绑到**已有会话（路由表的另一半：只绑 agent 不够，还要能指定会话）。 */
  bind(connectionId: string, chatId: string, sessionId: string): Promise<{ ok: boolean; reason?: string }>;
  /** 从渠道日志 feed 订阅（SSE 用）。 */
  onLog(listener: (entry: ChannelLogEntry) => void): () => void;
  /** 最近的日志（新订阅者先补一份，避免页面一打开是空白）。 */
  recentLogs(): ChannelLogEntry[];
  /** 发文件到某会话所属的渠道（`sendFileToUser` 动作的落地）。 */
  sendFileToSession(sessionId: string, input: { filePath: string; caption?: string }): Promise<{ ok: boolean; reason?: string }>;
  /** 重扫渠道目录（事件与手动 reload 都走这里）。 */
  rescan(): Promise<void>;
  /** 卸载：释放全部订阅，断开全部连接（provider 自己也会清，幂等）。 */
  dispose(): Promise<void>;
}

export interface GatewayDeps {
  host: PluginServerHost;
  state: StateStore;
}

const LOG_RING = 200;
/** 同一条聊天串行化，避免并发入站各自 `ensure` 出一个会话。 */
const inboundChains = new Map<string, Promise<void>>();

export function createGateway(deps: GatewayDeps): Gateway {
  const { host, state } = deps;
  const channels = new Map<string, ChannelEntry>();
  const replies = new Map<string, ReplySubscription>();
  const logListeners = new Set<(entry: ChannelLogEntry) => void>();
  const logRing: ChannelLogEntry[] = [];
  const attaching = new Set<string>();
  let disposed = false;

  function log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    host.log(level, message, extra);
  }

  function emitLog(level: 'info' | 'warn' | 'error', message: string, extra?: { providerId?: string; connectionId?: string }): void {
    const entry: ChannelLogEntry = { timestamp: Date.now(), level, message, ...extra };
    logRing.push(entry);
    if (logRing.length > LOG_RING) logRing.shift();
    for (const listener of logListeners) {
      try {
        listener(entry);
      } catch {
        /* 订阅者自己的问题，不影响网关 */
      }
    }
  }

  // ── 连接注册表 ────────────────────────────────────────────────────────────

  function ownerOf(connectionId: string): ChannelEntry | undefined {
    for (const entry of channels.values()) {
      if (entry.connections.has(connectionId)) return entry;
    }
    return undefined;
  }

  function declareConnection(providerId: string, meta: ConnectionMeta): void {
    const entry = channels.get(providerId);
    if (!entry) return;
    if (typeof meta?.id !== 'string' || !meta.id) {
      log('warn', 'declare 收到非法连接元信息', { providerId, meta });
      return;
    }
    if (entry.connections.has(meta.id)) return;
    entry.connections.add(meta.id);
    state.ensureConnection(meta.id);
    emitLog('info', `连接已登记：${meta.label || meta.id}`, { providerId, connectionId: meta.id });
  }

  /**
   * 从网关侧移除一条连接：连接表 + 状态 + 它名下的**全部绑定**。
   *
   * 绑定必须一起清 —— 否则同一个 chatId 再次出现时会直接复用一条指向
   * 已不存在连接的绑定（"删了重加还回老会话"就是这么来的）。
   */
  function retireLocal(entry: { connections: Set<string>; providerId: string }, connectionId: string): void {
    entry.connections.delete(connectionId);
    for (const [key] of state.bindingsOfConnection(connectionId)) {
      state.removeBinding(connectionId, key.slice(key.indexOf('|') + 1));
    }
    state.removeConnection(connectionId);
  }

  function makeUplink(providerId: string): ImUplink {
    return {
      declare: (meta) => declareConnection(providerId, meta),
      retire: (connectionId) => {
        const entry = channels.get(providerId);
        if (!entry) return;
        retireLocal(entry, connectionId);
        emitLog('info', '连接已移除', { providerId, connectionId });
        releaseOfflineSubscriptions();
      },
      onInbound: (msg) => handleInbound(providerId, msg),
      onStatus: (evt) => handleStatus(providerId, evt.connectionId, evt.status, evt.error),
    };
  }

  function handleStatus(providerId: string, connectionId: string, status: ChannelStatus, error?: string): void {
    const entry = channels.get(providerId);
    // 迟到的状态（连接已删除 / 已换主）直接丢弃：不让它污染状态机。
    if (!entry || !entry.connections.has(connectionId)) return;
    state.updateConnection(connectionId, { status, ...(error ? { lastError: error } : {}) });
    emitLog(status === 'error' ? 'error' : 'info', `连接状态：${status}${error ? `（${error}）` : ''}`, {
      providerId,
      connectionId,
    });
    if (status !== 'connected') releaseOfflineSubscriptions();
  }

  // ── 发现（快照 + 插件级事件）──────────────────────────────────────────────

  async function attach(providerId: string, serviceName: string): Promise<void> {
    if (channels.has(providerId) || attaching.has(providerId)) return;
    attaching.add(providerId);
    try {
      const raw = await host.services.call(serviceName, { uplink: makeUplink(providerId) });
      const driver = raw as ChannelDriver | undefined;
      if (!driver || typeof driver !== 'object') {
        log('warn', '渠道没有返回 driver', { providerId, serviceName });
        return;
      }
      if (driver.apiVersion !== CHANNEL_API_VERSION) {
        log('warn', '渠道契约版本不匹配，已跳过', { providerId, got: driver.apiVersion, want: CHANNEL_API_VERSION });
        return;
      }
      const entry: ChannelEntry = {
        providerId,
        serviceName,
        driver,
        connections: new Set<string>(),
      };
      channels.set(providerId, entry);
      log('info', '渠道已接入', { providerId, type: driver.type, label: driver.label });

      for (const meta of driver.connections() ?? []) declareConnection(providerId, meta);
      // 无记录 = 启用（首次见到就该连上）。
      for (const connectionId of entry.connections) {
        if (!state.ensureConnection(connectionId).enabled) continue;
        await connectOne(providerId, connectionId);
      }
    } catch (err) {
      // 一个渠道接不上不影响别的渠道（失败隔离）。
      log('warn', '渠道接入失败', { providerId, err: String(err) });
      state.updateConnection(providerId, { status: 'error', lastError: String(err) });
    } finally {
      attaching.delete(providerId);
    }
  }

  async function connectOne(providerId: string, connectionId: string): Promise<void> {
    const entry = channels.get(providerId);
    if (!entry) return;
    try {
      await entry.driver.connect(connectionId);
      emitLog('info', '已发起连接', { providerId, connectionId });
    } catch (err) {
      state.updateConnection(connectionId, { status: 'error', lastError: String(err) });
      emitLog('error', `连接失败：${String(err)}`, { providerId, connectionId });
    }
  }

  async function disconnectOne(providerId: string, connectionId: string): Promise<void> {
    const entry = channels.get(providerId);
    if (!entry) return;
    try {
      await entry.driver.disconnect(connectionId);
    } catch (err) {
      log('warn', '断开连接失败（继续摘除）', { providerId, connectionId, err: String(err) });
    }
    emitLog('info', '已断开连接', { providerId, connectionId });
  }

  async function detach(providerId: string): Promise<void> {
    const entry = channels.get(providerId);
    if (!entry) return;
    channels.delete(providerId);
    for (const connectionId of entry.connections) state.updateConnection(connectionId, { status: 'disconnected' });
    log('info', '渠道已摘除', { providerId });
    releaseOfflineSubscriptions();
  }

  async function rescan(): Promise<void> {
    if (disposed) return;
    let services: Array<{ name: string; owner: string; namespace?: string }> = [];
    try {
      services = host.services.list({ namespace: CHANNEL_NAMESPACE });
    } catch (err) {
      log('warn', '服务目录查询失败', { err: String(err) });
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
      // 拼错 namespace 的唯一可见信号（渠道装了但看不见时，日志里只有这一条）。
      log('debug', '当前没有任何 IM 渠道（namespace im.channel 为空）', { namespace: CHANNEL_NAMESPACE });
    }
  }

  // ── 入站 → 会话 ───────────────────────────────────────────────────────────

  async function handleInbound(providerId: string, msg: InboundMessage): Promise<void> {
    const entry = channels.get(providerId);
    if (!entry) {
      log('warn', '收到未知渠道的入站消息', { providerId });
      return;
    }
    if (!entry.connections.has(msg.connectionId)) {
      log('warn', '收到未知连接的入站消息', { providerId, connectionId: msg.connectionId });
      return;
    }
    const key = `${providerId}|${msg.connectionId}|${msg.chatId}`;
    const previous = inboundChains.get(key) ?? Promise.resolve();
    const next = previous.then(() => routeInbound(entry, msg)).catch((err) => {
      log('warn', '入站处理失败', { providerId, connectionId: msg.connectionId, err: String(err) });
    });
    inboundChains.set(key, next);
    await next;
  }

  async function routeInbound(entry: ChannelEntry, msg: InboundMessage): Promise<void> {
    const connection = state.ensureConnection(msg.connectionId);
    const agentId = connection.agentId;
    if (!agentId) {
      await entry.driver.send(msg.connectionId, msg.chatId, {
        text: '这条连接还没有绑定 agent（在 IM 网关页面里设置后再试）。',
      });
      return;
    }

    const command = parseCommand(msg.text);
    // 路由顺序（spec `im-gateway-admin`）：显式 chat 绑定 → 连接默认会话 → 自动新建。
    // 默认会话让"第一次绑定"不必先发一条消息把会话创建出来。
    let existing = state.getBinding(msg.connectionId, msg.chatId)?.sessionId;
    const viaDefault = !existing;
    if (!existing && connection.defaultSessionId) {
      const detail = await host.sessions.detail(connection.defaultSessionId);
      if (detail && detail.agentId === agentId) {
        existing = connection.defaultSessionId;
      } else {
        log('warn', '连接默认会话不可用（会话不存在或属于别的 agent），按自动新建处理', {
          connectionId: msg.connectionId,
          defaultSessionId: connection.defaultSessionId,
        });
      }
    }

    // `/new` 必须由网关处理：它要重新绑定。
    if (command?.name === 'new') {
      const created = await host.sessions.ensure({ agentId, title: `IM · ${entry.driver.label}` });
      state.setBinding(msg.connectionId, msg.chatId, created.sessionId);
      await entry.driver.send(msg.connectionId, msg.chatId, {
        text: `已新建会话（${created.sessionId.slice(0, 8)}）`,
      });
      emitLog('info', '已按 /new 新建会话', { providerId: entry.providerId, connectionId: msg.connectionId });
      return;
    }

    // 会话还能不能复用：存在、且**属于当前 agent**。
    //
    // 归属检查不是多余 —— 用户在网关页把连接换到另一个 agent 后，旧绑定指向的会话
    // 属于上一个 agent；内核的 `ensure` 对这种情况 fail closed（抛错），网关必须
    // 自己先判定并平滑地重建，否则"换了 agent 之后这条聊天再也不回消息"。
    let reusable = existing;
    if (reusable) {
      const detail = await host.sessions.detail(reusable);
      if (!detail || detail.agentId !== agentId) reusable = undefined;
    }

    const ensured = await host.sessions.ensure({
      agentId,
      sessionId: reusable,
      title: `IM · ${entry.driver.label}`,
    });
    // 落"显式绑定"的两种情形：会话是新 ensure 出来的，或这次走的是连接默认会话
    // （走默认时也要固化 —— 以后改默认会话，不该把已经进过的聊天悄悄改道）。
    if (ensured.sessionId !== state.getBinding(msg.connectionId, msg.chatId)?.sessionId) {
      state.setBinding(msg.connectionId, msg.chatId, ensured.sessionId);
      if (viaDefault && existing) {
        emitLog('info', '按连接默认会话路由并固化绑定', {
          providerId: entry.providerId,
          connectionId: msg.connectionId,
        });
      }
    }

    // 附件：写进附件库，再把元信息交给 worker（worker 自己按 sha 读盘）。
    const attachments = [];
    for (const att of msg.attachments ?? []) {
      try {
        const saved = await host.attachments.upload({
          sessionId: ensured.sessionId,
          bytes: att.bytes,
          mimeType: att.mimeType,
          filename: att.filename,
        });
        attachments.push(saved);
      } catch (err) {
        log('warn', '附件上传失败', { sessionId: ensured.sessionId, err: String(err) });
      }
    }

    const text = msg.text?.trim() || (attachments.length > 0 ? '[用户发来附件]' : '');
    if (!text) return;

    // 先订阅再投递：投递是异步的，回复可能来得很快。
    ensureReplySubscription(ensured.sessionId);

    if (command && command.name !== 'new') {
      // 其它斜杠命令交给 worker 的 pi-native 分发（`/compact` `/help` …）。
      try {
        await host.sessions.call(ensured.sessionId, 'dispatchCommand', [command.name, command.args]);
        emitLog('info', `已执行命令 /${command.name}`, { providerId: entry.providerId, connectionId: msg.connectionId });
        return;
      } catch (err) {
        log('debug', '命令分发失败，按普通消息处理', { command: command.name, err: String(err) });
      }
    }

    await host.sessions.call(ensured.sessionId, 'prompt', [
      text,
      attachments.length > 0 ? { attachments } : undefined,
    ]);
    emitLog('info', '已投递到会话', { providerId: entry.providerId, connectionId: msg.connectionId });
  }

  /** 极简斜杠命令解析：`/name args...`。 */
  function parseCommand(text: string | undefined): { name: string; args: string } | null {
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;
    const [head, ...rest] = trimmed.slice(1).split(/\s+/);
    if (!head) return null;
    return { name: head.toLowerCase(), args: rest.join(' ') };
  }

  // ── 会话事件 → 渠道（过滤 + 聚合）──────────────────────────────────────────

  /**
   * 回复管线（spec `im-gateway-plugin`「回复 MUST 经过过滤与聚合」）：
   * - 只处理 `assistant`（跳过 user / tool result）
   * - 跳过带 `toolCalls` 的中间消息（否则用户先收到"我查一下"）
   * - `message_update` 是**累积快照**（覆盖不追加）
   * - 只有 `message_end` 才真正投递（IM 没有"编辑消息"）
   */
  function ensureReplySubscription(sessionId: string): void {
    if (replies.has(sessionId)) return;
    const projector = createSessionProjector();
    const entry: ReplySubscription = { dispose: () => {}, projector, pending: null };
    const dispose = host.sessions.subscribe(
      sessionId,
      (raw) => {
        const evt = raw as { kind?: string };
        if (evt?.kind !== 'event') return;
        let projected;
        try {
          projected = projector.project(evt as never);
        } catch {
          return;
        }
        if (!projected) return;
        const dto = projected.data as
          | { messageId?: string; content?: string; role?: string; toolCalls?: unknown[] }
          | undefined;
        if (!dto?.messageId) return;
        if (dto.role && dto.role !== 'assistant') return;

        if (projected.name === 'message_update') {
          entry.pending = { messageId: dto.messageId, text: dto.content ?? '', done: false };
          return;
        }
        if (projected.name !== 'message_end') return;

        const pending = entry.pending;
        if (!pending || pending.messageId !== dto.messageId || pending.done) return;
        // 先认领再 await：同一条 message_end 重复送达时不会发两遍。
        pending.done = true;
        entry.pending = null;
        if (Array.isArray(dto.toolCalls) && dto.toolCalls.length > 0) return; // 中间话，不发

        const text = pending.text.trim();
        if (!text) return;
        void deliver(sessionId, text);
      },
      () => {
        // worker 死了 / 会话终结：订阅随之失效，下次入站重新建立。
        replies.delete(sessionId);
      },
    );
    entry.dispose = dispose;
    replies.set(sessionId, entry);
  }

  async function deliver(sessionId: string, text: string): Promise<void> {
    for (const [key, binding] of Object.entries(state.get().bindings)) {
      if (binding.sessionId !== sessionId) continue;
      const { connectionId, chatId } = splitKey(key);
      const entry = ownerOf(connectionId);
      if (!entry) continue;
      if (state.get().connections[connectionId]?.status !== 'connected') continue;
      try {
        await entry.driver.send(connectionId, chatId, { text });
        emitLog('info', '已投递回复', { providerId: entry.providerId, connectionId });
      } catch (err) {
        emitLog('error', `回复投递失败：${String(err)}`, { providerId: entry.providerId, connectionId });
      }
    }
  }

  /**
   * 释放"没有任何在线连接"的会话订阅。
   *
   * `unknown` 不算下线：渠道刚接入、状态还没回来时释放会导致刚订阅就退订的抖动。
   */
  function releaseOfflineSubscriptions(): void {
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
        return status === 'connected' || status === 'unknown';
      });
      if (anyOnline) continue;
      sub.dispose();
      replies.delete(sessionId);
      const firstKey = related[0]?.[0];
      emitLog('info', '连接全部下线，会话订阅已释放', {
        ...(firstKey ? { connectionId: splitKey(firstKey).connectionId } : {}),
      });
    }
  }

  // ── 对外查询 / 操作 ───────────────────────────────────────────────────────

  function listConnections() {
    const out: ReturnType<Gateway['listConnections']> = [];
    for (const entry of channels.values()) {
      for (const connectionId of entry.connections) {
        const st: ConnectionState = state.get().connections[connectionId] ?? {
          enabled: true,
          status: 'unknown',
          updatedAt: 0,
        };
        out.push({
          id: connectionId,
          providerId: entry.providerId,
          type: entry.driver.type,
          label: entry.driver.label,
          enabled: st.enabled,
          status: st.status,
          canRemove: typeof entry.driver.remove === 'function',
          ...(st.lastError ? { lastError: st.lastError } : {}),
          ...(st.agentId ? { agentId: st.agentId } : {}),
          ...(st.defaultSessionId ? { defaultSessionId: st.defaultSessionId } : {}),
          bindings: state.bindingsOfConnection(connectionId).map(([key, b]) => ({
            chatId: splitKey(key).chatId,
            sessionId: b.sessionId,
            updatedAt: b.updatedAt,
          })),
        });
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  return {
    listConnections,
    listChannels: () =>
      [...channels.values()].map((entry) => ({
        providerId: entry.providerId,
        type: entry.driver.type,
        label: entry.driver.label,
        connections: entry.connections.size,
        canSendFile: typeof entry.driver.sendFile === 'function',
      })),
    async setConnectionEnabled(connectionId, enabled) {
      const entry = ownerOf(connectionId);
      if (!entry) throw new Error(`未知连接：${connectionId}`);
      state.updateConnection(connectionId, { enabled });
      if (enabled) await connectOne(entry.providerId, connectionId);
      else {
        await disconnectOne(entry.providerId, connectionId);
        state.updateConnection(connectionId, { status: 'disconnected' });
        releaseOfflineSubscriptions();
      }
    },
    setConnectionAgent(connectionId, agentId) {
      const entry = ownerOf(connectionId);
      if (!entry) throw new Error(`未知连接：${connectionId}`);
      if (!host.agents.get(agentId)) throw new Error(`未知 agent：${agentId}`);
      const previous = state.get().connections[connectionId]?.agentId;
      state.updateConnection(connectionId, { agentId });
      if (previous && previous !== agentId) {
        // 换 agent = 旧绑定与默认会话全部作废（那些会话属于上一个 agent，不能继续投递）。
        for (const [key] of state.bindingsOfConnection(connectionId)) {
          state.removeBinding(connectionId, key.slice(key.indexOf('|') + 1));
        }
        state.updateConnection(connectionId, { defaultSessionId: undefined });
        releaseOfflineSubscriptions();
      }
    },
    async setDefaultSession(connectionId, sessionId) {
      const entry = ownerOf(connectionId);
      if (!entry) throw new Error(`未知连接：${connectionId}`);
      if (sessionId) {
        // 默认会话必须属于该连接的 agent —— 否则第一条消息就会 ensure 失败。
        const agentId = state.get().connections[connectionId]?.agentId;
        if (!agentId) throw new Error('先给这条连接指定 agent，再选默认会话');
        const detail = await host.sessions.detail(sessionId);
        if (!detail) throw new Error(`会话不存在：${sessionId}`);
        if (detail.agentId !== agentId) throw new Error('该会话不属于这条连接的 agent');
        state.updateConnection(connectionId, { defaultSessionId: sessionId });
      } else {
        state.updateConnection(connectionId, { defaultSessionId: undefined });
      }
    },
    async removeConnection(connectionId) {
      const entry = ownerOf(connectionId);
      if (!entry) return { ok: false, reason: `未知连接：${connectionId}` };
      if (typeof entry.driver.remove !== 'function') {
        return {
          ok: false,
          reason: '该渠道没有提供删除能力，请手工修改它的配置文件后再刷新',
        };
      }
      try {
        await entry.driver.disconnect(connectionId).catch(() => undefined);
        await entry.driver.remove(connectionId);
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
      // 渠道侧已删：网关这边 retire（清绑定、移出连接表、重算订阅）。
      retireLocal(entry, connectionId);
      releaseOfflineSubscriptions();
      emitLog('info', '已删除连接', { providerId: entry.providerId, connectionId });
      return { ok: true };
    },
    listBindings(filter) {
      const out: ReturnType<Gateway['listBindings']> = [];
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
      if (!entry) return { ok: false, reason: `未知连接：${connectionId}` };
      const detail = await host.sessions.detail(sessionId);
      if (!detail) return { ok: false, reason: `会话不存在：${sessionId}` };
      const agentId = state.get().connections[connectionId]?.agentId;
      if (agentId && detail.agentId && detail.agentId !== agentId) {
        // 绑到别的 agent 的会话 = 之后每条消息都会被 `ensure` 拒掉（fail closed），
        // 所以这里先拦下并说清原因，不留半死状态。
        return { ok: false, reason: '该会话属于另一个 agent，先把连接的 agent 改过去再绑' };
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
      const targets = Object.entries(state.get().bindings)
        .filter(([, b]) => b.sessionId === sessionId)
        .map(([key]) => key);
      if (targets.length === 0) return { ok: false, reason: '这个会话没有绑定任何 IM 聊天' };
      let sent = 0;
      const reasons: string[] = [];
      for (const key of targets) {
        const { connectionId, chatId } = splitKey(key);
        const entry = ownerOf(connectionId);
        if (!entry) continue;
        try {
          if (typeof entry.driver.sendFile === 'function') {
            await entry.driver.sendFile(connectionId, chatId, input);
          } else {
            await entry.driver.send(connectionId, chatId, {
              text: `${input.caption ? `${input.caption}\n` : ''}${input.filePath}`,
            });
          }
          sent += 1;
        } catch (err) {
          reasons.push(String(err));
        }
      }
      if (sent === 0) return { ok: false, reason: reasons.join('; ') || '没有在线连接' };
      return { ok: true };
    },
    rescan,
    async dispose() {
      disposed = true;
      for (const sub of replies.values()) sub.dispose();
      replies.clear();
      logListeners.clear();
      await state.flush();
    },
  };
}

/** 拆绑定 key（`<connectionId>|<chatId>`）；chatId 本身可能含 `|`，所以只切第一段。 */
function splitKey(key: string): { connectionId: string; chatId: string } {
  const idx = key.indexOf('|');
  return idx < 0 ? { connectionId: key, chatId: '' } : { connectionId: key.slice(0, idx), chatId: key.slice(idx + 1) };
}

/** 供 HTTP 层复用的绑定 key 生成（避免两处各拼一次）。 */
export { bindingKey };
