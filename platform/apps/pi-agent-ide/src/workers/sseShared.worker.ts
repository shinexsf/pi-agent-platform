/**
 * SharedWorker：整个 origin 共用一条 SSE，不再是"每个标签页各占一条"。
 *
 * 背景：浏览器对 HTTP/1.1 每个 origin 只给 6 条连接，而会话页会把一条 SSE
 * 挂到标签页关闭为止。开几个标签页就把连接池占满，之后任何 /api 请求都排队，
 * 页面表现为"打不开 / 白屏 / 提交无反应"。SharedWorker 是**每个 origin 一个
 * 实例**（不是每个标签页），所以 N 个标签页看同一个会话，服务端只看到 1 条流。
 *
 * 隔离性：每个标签页是独立的 MessagePort，worker 按 sessionId 只把事件发给
 * 订阅了该会话的 port。不同会话互不可见；不同设备（手机 / PC）是两个浏览器
 * 进程，各有自己的 worker 和自己那条流，同样互不可见。
 *
 * 存活：标签页被强杀或崩溃时不会说再见，所以客户端定期 ping，worker 丢弃长期
 * 静默的 port；某个会话的 port 全部离开后关闭底层 EventSource，把连接还给
 * 浏览器。标签页从后台冻结中醒来时会重新 subscribe 一次（幂等），借此重新
 * 挂回订阅。
 */

/** 与 `shared-types` 里 WorkerEvent 的名字保持一致；`connected` 是服务端 hello 帧。 */
const SESSION_EVENTS = [
  'connected',
  'session_snapshot',
  'agent_start',
  'agent_settled',
  'session_disposed',
  'message_update',
  'message_end',
  'agent_end',
  'queue_update',
  'message_error',
  // 插件事件（change: plugin-mechanism）——固定事件名 `plugin`，载荷带 pluginId/name。
  // 注意：**新增具名 SSE 事件时必须同步加到这里**，否则共享连接模式下会被静默丢弃
  // （直连 EventSource 没有这个白名单，两边行为会不一致）。
  'plugin',
] as const

/** 静默超过这个时间的 port 视为已被浏览器回收（标签页崩溃 / 冻结后不再唤醒）。 */
const PRUNE_AFTER_MS = 10 * 60_000
/** 清理扫描间隔。 */
const SWEEP_EVERY_MS = 60_000

interface SessionEntry {
  es: EventSource
  /** port → 最后一次 ping 的时间戳 */
  ports: Map<MessagePort, number>
}

type Incoming =
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe' }
  | { type: 'ping' }

const sessions = new Map<string, SessionEntry>()
/** 反查某个 port 当前挂在哪个会话上（unsubscribe / ping 用）。 */
const portSession = new WeakMap<MessagePort, string>()

function post(port: MessagePort, msg: unknown): void {
  try {
    port.postMessage(msg)
  } catch {
    // Port 已随标签页销毁，忽略：清理交给 sweep。
  }
}

function broadcast(entry: SessionEntry, msg: unknown): void {
  for (const port of entry.ports.keys()) post(port, msg)
}

function closeSession(sessionId: string, entry: SessionEntry): void {
  entry.es.close()
  sessions.delete(sessionId)
}

function openSession(sessionId: string): SessionEntry {
  const es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`)
  const entry: SessionEntry = { es, ports: new Map() }

  // 顶层的 open / error 是 EventSource 自身的心跳，转发给客户端用来维护
  // `connected` 状态；命名事件（message_update 等）原样转发 payload。
  es.addEventListener('open', () => broadcast(entry, { type: 'open' }))
  es.addEventListener('error', () => broadcast(entry, { type: 'error' }))
  for (const name of SESSION_EVENTS) {
    es.addEventListener(name, (ev) => {
      const e = ev as MessageEvent
      broadcast(entry, {
        type: 'event',
        event: name,
        data: e.data ?? '',
        lastEventId: e.lastEventId ?? '',
      })
    })
  }

  sessions.set(sessionId, entry)
  return entry
}

/** 幂等：同一 port 重复 subscribe 会先摘掉旧订阅再挂新的（刷新 lastSeen）。 */
function subscribe(port: MessagePort, sessionId: string): void {
  unsubscribe(port)
  const entry = sessions.get(sessionId) ?? openSession(sessionId)
  entry.ports.set(port, Date.now())
  portSession.set(port, sessionId)
  // EventSource 已连上时立刻告诉客户端，避免它等下一次 open
  if (entry.es.readyState === EventSource.OPEN) post(port, { type: 'open' })
}

function unsubscribe(port: MessagePort): void {
  const sessionId = portSession.get(port)
  if (!sessionId) return
  portSession.delete(port)
  const entry = sessions.get(sessionId)
  if (!entry) return
  entry.ports.delete(port)
  if (entry.ports.size === 0) closeSession(sessionId, entry)
}

const scope = self as unknown as { onconnect: ((ev: MessageEvent) => void) | null }

scope.onconnect = (ev: MessageEvent) => {
  const port = ev.ports[0]
  if (!port) return
  port.onmessage = (e: MessageEvent) => {
    const msg = e.data as Incoming
    if (msg.type === 'subscribe') {
      subscribe(port, msg.sessionId)
      return
    }
    if (msg.type === 'unsubscribe') {
      unsubscribe(port)
      return
    }
    // ping：回 pong 并刷新存活时间
    const sessionId = portSession.get(port)
    const entry = sessionId ? sessions.get(sessionId) : undefined
    if (entry) entry.ports.set(port, Date.now())
    post(port, { type: 'pong' })
  }
}

// 浏览器在最后一个 port 关闭后可能直接终止 worker；这个定时器只在有 port
// 期间有意义（否则浏览器会连同 worker 一起回收）。
setInterval(() => {
  const now = Date.now()
  for (const [sessionId, entry] of [...sessions]) {
    for (const [port, seen] of [...entry.ports]) {
      if (now - seen > PRUNE_AFTER_MS) {
        entry.ports.delete(port)
        portSession.delete(port)
      }
    }
    if (entry.ports.size === 0) closeSession(sessionId, entry)
  }
}, SWEEP_EVERY_MS)

export {}
