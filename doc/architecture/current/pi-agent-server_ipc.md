# pi-agent-server ipc

> IPC 协议。master 通过 `child_process` IPC 跟 worker 通信。支持双向 RPC。

## 设计目标

- ✅ **代码层透明**：master 端像直接调 pi SDK
- ✅ **零依赖**：不引入 RPC 框架
- ✅ **类型安全**：复用 pi SDK 类型（`AgentSession`）
- ✅ **双向 RPC**：worker 可回调 master（sendFileToUser 等工具）

## 协议格式

```typescript
// master → worker
{ kind: 'call', id: number, method: string, args: any[] }
// 或初始化
{ kind: 'init', config: InitConfig }

// worker → master
{ kind: 'response', id: number, result?: any, error?: string }
{ kind: 'event', event: any }    // 透传 pi SDK 事件
{ kind: 'reverse-call', id: number, method: ReverseMethod, args: unknown[] }  // worker → master RPC

// master → worker（响应反向调用）
{ kind: 'reverse-response', id: number, ok: boolean, result?: any, error?: { message: string } }
```

**master→worker method** 直接是 pi SDK API（`prompt` / `setModel` / `abort` / `setSessionName` / 等）。

**worker→master method** 是自定义的 `ReverseMethod`（当前仅 `'sendFileToUser'`，可扩展）。

## Master 端：AgentSessionProxy

```typescript
// packages/sdk-integration/src/agent-session-proxy.ts
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent';

export class AgentSessionProxy implements AgentSession {
  private callId = 0;
  private pending = new Map<number, { resolve: Function; reject: Function }>();
  private listeners = new Set<(event: AgentSessionEvent) => void>();

  constructor(private worker: ChildProcess) {
    this.worker.on('message', (msg) => {
      if (msg.kind === 'response') {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
      } else if (msg.kind === 'event') {
        for (const fn of this.listeners) fn(msg.event);
      }
    });
  }

  // ===== 方法签名跟 pi SDK 的 AgentSession 完全一致 =====
  prompt(message: string, images?: string[]): Promise<void> {
    return this.call('prompt', [message, images]);
  }

  setModel(model: string): Promise<void> {
    return this.call('setModel', [model]);
  }

  abort(): Promise<void> {
    return this.call('abort', []);
  }

  subscribe(handler: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  private call(method: string, args: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.callId;
      this.pending.set(id, { resolve, reject });
      this.worker.send({ kind: 'call', id, method, args });
    });
  }
}
```

## Worker 端：method dispatch

```typescript
// workers/session-worker/src/index.ts
import { createAgentSession, type AgentSession } from '@earendil-works/pi-coding-agent';

let session: AgentSession;

process.on('message', async (msg) => {
  try {
    let result;

    if (msg.kind === 'init') {
      const r = await createAgentSession(msg.config);
      session = r.session;
      // 事件转发给 master
      session.subscribe((event) => process.send({ kind: 'event', event }));
      result = { sessionId: r.session.id };
    } else if (msg.kind === 'call') {
      // method 直接是 session 上的方法名（来自 pi SDK）
      const fn = (session as any)[msg.method];
      if (typeof fn !== 'function') {
        throw new Error(`Unknown method: ${msg.method}`);
      }
      result = await fn.apply(session, msg.args);
    }

    process.send({ kind: 'response', id: msg.id, result });
  } catch (err) {
    process.send({ kind: 'response', id: msg.id, error: (err as Error).message });
  }
});
```

## Master 端业务代码

```typescript
// 完全像直接调 pi SDK
const session = await AgentSessionProxy.create(worker, config);
await session.prompt('Hello');           // 看起来像本地
session.subscribe((event) => {           // 也像本地
  // event 是 AgentSessionEvent 类型
});
```

**两边 `session.prompt(...)` 写法一模一样**，类型也一样（都是 `AgentSession`）。

## 与决策 20 反对的 "pi RPC" 对比

| 维度 | pi `--mode rpc`（决策 20 反对）| 本方案 |
|---|---|---|
| 协议所有权 | pi 的 | **我们的** |
| 能力暴露 | RPC 子集 | **100%**（worker 包装 SDK）|
| 协议耦合 | Server ↔ pi | master ↔ worker（自控）|
| 升级影响 | pi 改协议 → Server 改 | 只改 worker 实现 |

## 错误处理

worker 抛错 → 错误通过 `kind: 'response'` 的 `error` 字段传回 → proxy 重建 Error 对象抛出。

业务错误（model 不可用等）→ 通过 `kind: 'event'` 透传 pi SDK 的 error event → master SSE 推到客户端 chat 流。

## 标题同步通道（title ↔ pi 原生命名）

三组协议字段服务 `sessions.title` 与 pi display name 的双向同步：

- **master→worker**：`setSessionName` —— pi SDK `AgentSession.setSessionName()` 的透传。它是内存 API 但穿透写文件（内部 append jsonl `session_info` entry 并**同步**发事件，先于本次 call 的 response 到达 master，FIFO 无竞态）；worker 活着时禁止绕过它直接改 jsonl（树簿记依赖内存态）。
- **worker→master 事件**：`session_info_changed`（`data: { name }`）—— **master 内部消费**写 `sessions.title`（无 row 即 placeholder → debug 跳过、不缓冲），**不进 SSE 流**（`routes/events.ts` 过滤，双端 useSSE 契约不变）。
- **`CreateSessionResult.sessionName`**：`createSession` 带出 pi 侧当前名字，供 `spawnAndCreate` 加载时与 DB title 比对（heal，DB 优先）。

命名来源三通道（平台手动改名 / pi TUI / 未来自动命名插件）全部汇入同一事件回流；三种会话状态的行为矩阵见 [`pi-agent-server_session-lifecycle.md`](pi-agent-server_session-lifecycle.md) 的“Session title 双向同步”。

## 相关文档

- [`pi-agent-server_worker-pool.md`](pi-agent-server_worker-pool.md) —— 进程模型
- [`pi-agent-server_overview.md`](pi-agent-server_overview.md) —— 整体定位