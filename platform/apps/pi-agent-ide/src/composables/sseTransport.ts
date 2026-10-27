/**
 * SSE 传输层抽象：`useSSE` 只依赖 `addEventListener / open / close` 这几个
 * 类似 EventSource 的能力，具体是直连还是经 SharedWorker 复用在这里切换。
 *
 * - `SharedTransport`：整个浏览器（同 origin）共用一条 SSE，多标签页不再各占
 *   一条连接。见 `workers/sseShared.worker.ts`。
 * - `DirectTransport`：原来的 `new EventSource(...)`。SharedWorker 不可用
 *   （旧内核 / 受限的宿主，例如某些 JCEF 配置）时自动回退，行为与改造前一致。
 */

/** 与 EventSource 对齐的最小接口。 */
export interface SseTransport {
  /** 等价于 `eventSource.readyState === EventSource.OPEN`。 */
  readonly open: boolean
  addEventListener(type: string, fn: (e: MessageEvent) => void): void
  close(): void
  /** 幂等地重新挂上订阅（标签页从后台冻结中醒来时用来补救）。可选。 */
  resubscribe?(): void
}

/** 共享连接的心跳间隔：worker 据此判断 port 是否还活着。 */
const PING_INTERVAL_MS = 30_000

class DirectTransport implements SseTransport {
  private readonly es: EventSource
  private readonly handlers = new Map<string, Set<(e: MessageEvent) => void>>()

  constructor(url: string) {
    this.es = new EventSource(url)
  }

  get open(): boolean {
    return this.es.readyState === EventSource.OPEN
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    if (type === 'open' || type === 'error') {
      // 原生 EventSource 的 open / error 不是 MessageEvent，包一层统一签名
      this.es.addEventListener(type, (ev) => fn(ev as unknown as MessageEvent))
      return
    }
    let set = this.handlers.get(type)
    if (!set) {
      set = new Set()
      this.handlers.set(type, set)
      this.es.addEventListener(type, (ev) => {
        for (const handler of set!) handler(ev as MessageEvent)
      })
    }
    set.add(fn)
  }

  close(): void {
    this.es.close()
    this.handlers.clear()
  }
}

interface WorkerEventFrame {
  type: 'event'
  event: string
  data: string
  lastEventId: string
}

type WorkerFrame =
  | WorkerEventFrame
  | { type: 'open' }
  | { type: 'error' }
  | { type: 'pong' }

class SharedTransport implements SseTransport {
  private readonly worker: SharedWorker
  private readonly port: MessagePort
  private readonly handlers = new Map<string, Set<(e: MessageEvent) => void>>()
  private readonly pingTimer: ReturnType<typeof setInterval>
  private readonly sessionId: string
  private ready = false
  private closed = false

  constructor(sessionId: string) {
    this.sessionId = sessionId
    // Vite 要求 worker 选项是**字面量**（它需要在构建期静态解析），所以 name
    // 只能写死；每个 app 一份本文件，各自用自己的名字区分共享实例。
    this.worker = new SharedWorker(new URL('../workers/sseShared.worker.ts', import.meta.url), {
      name: 'pi-sse-ide',
      type: 'module',
    })
    this.port = this.worker.port
    this.port.onmessage = (e: MessageEvent) => this.dispatch(e.data as WorkerFrame)
    this.port.start()
    this.port.postMessage({ type: 'subscribe', sessionId })
    this.pingTimer = setInterval(() => {
      if (!this.closed) this.port.postMessage({ type: 'ping' })
    }, PING_INTERVAL_MS)
  }

  get open(): boolean {
    return this.ready
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    let set = this.handlers.get(type)
    if (!set) {
      set = new Set()
      this.handlers.set(type, set)
    }
    set.add(fn)
  }

  /** 冻结后台标签页会被 worker 剪掉订阅，醒来后重挂一次即可（幂等）。 */
  resubscribe(): void {
    if (this.closed) return
    this.port.postMessage({ type: 'subscribe', sessionId: this.sessionId })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.pingTimer)
    try {
      this.port.postMessage({ type: 'unsubscribe' })
    } catch {
      // worker 已死，无需清理
    }
    this.port.close()
    this.handlers.clear()
  }

  private dispatch(frame: WorkerFrame): void {
    if (frame.type === 'open') {
      this.ready = true
      this.emit('open', {} as MessageEvent)
      return
    }
    if (frame.type === 'error') {
      this.ready = false
      this.emit('error', {} as MessageEvent)
      return
    }
    if (frame.type === 'pong') return
    if (frame.type === 'event') {
      const ev = { data: frame.data, lastEventId: frame.lastEventId } as MessageEvent
      // 服务端 `connected` 是命名事件，走正常 handler
      if (frame.event === 'connected') this.ready = true
      this.emit(frame.event, ev)
    }
  }

  private emit(type: string, ev: MessageEvent): void {
    const set = this.handlers.get(type)
    if (!set) return
    for (const handler of set) handler(ev)
  }
}

/**
 * 创建传输层。SharedWorker 不可用时静默回退到直连 EventSource —— 两条路径的
 * 外层契约一致，`useSSE` 无需感知。
 */
export function createSseTransport(options: { sessionId: string }): SseTransport {
  const url = `/api/sessions/${encodeURIComponent(options.sessionId)}/events`
  if (typeof SharedWorker !== 'undefined') {
    try {
      return new SharedTransport(options.sessionId)
    } catch (err) {
      console.warn('[SSE] SharedWorker 不可用，回退到直连 EventSource:', err)
    }
  }
  return new DirectTransport(url)
}
