/**
 * 网关 HTTP 面（`/api/p/im/*`）。
 *
 * 为什么手写 `host.http.route` 而不是用动作的 `http` 投影：
 * 动作的 HTTP 面是 **POST + 精确路径 + 面向外部系统**（默认关闭），而这里是自家网关页调用的
 * 管理接口（GET / PATCH / DELETE）加一条 **SSE 流**。流式响应靠 handler 返回标准 `Response`，
 * 平台原样透传。
 */

import type { PluginHttpApi } from '@pi-agent-platform/plugin-types';
import type { Gateway } from './gateway.js';

type Http = PluginHttpApi['route'];

function json(data: unknown, status = 200): { status?: number; json: unknown } {
  return status === 200 ? { json: data } : { status, json: data };
}

export function registerRoutes(http: Http, gateway: Gateway): void {
  http({
    method: 'GET',
    path: '/connections',
    handler: () =>
      json({
        channels: gateway.listChannels(),
        connections: gateway.listConnections(),
      }),
  });

  http({
    method: 'PATCH',
    path: '/connections/:id',
    handler: async (req) => {
      const id = req.params.id ?? '';
      let patch: { enabled?: boolean; agentId?: string; defaultSessionId?: string | null } = {};
      try {
        patch = JSON.parse(req.body || '{}') as typeof patch;
      } catch {
        return json({ error: 'body 不是合法 JSON' }, 400);
      }
      try {
        if (typeof patch.enabled === 'boolean') await gateway.setConnectionEnabled(id, patch.enabled);
        if (typeof patch.agentId === 'string') gateway.setConnectionAgent(id, patch.agentId);
        // `defaultSessionId: null` = 清除；字符串 = 设为兜底会话。
        if (patch.defaultSessionId !== undefined) {
          await gateway.setDefaultSession(id, patch.defaultSessionId || null);
        }
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
      return json({ ok: true, connection: gateway.listConnections().find((c) => c.id === id) ?? null });
    },
  });

  // 删除一条连接：渠道删自己的配置条目（`driver.remove`），网关再 retire + 清绑定。
  // 渠道没实现 remove → 409 + 原因（页面据此禁用按钮，不静默失败）。
  http({
    method: 'DELETE',
    path: '/connections/:id',
    handler: async (req) => {
      const result = await gateway.removeConnection(req.params.id ?? '');
      return result.ok ? json({ ok: true }) : json({ error: result.reason ?? 'remove failed' }, 409);
    },
  });

  http({
    method: 'GET',
    path: '/bindings',
    handler: (req) => json({ bindings: gateway.listBindings(req.query.connectionId ? { connectionId: req.query.connectionId } : undefined) }),
  });

  http({
    method: 'PATCH',
    path: '/bindings/:connectionId/:chatId',
    handler: async (req) => {
      let body: { sessionId?: string } = {};
      try {
        body = JSON.parse(req.body || '{}') as { sessionId?: string };
      } catch {
        return json({ error: 'body 不是合法 JSON' }, 400);
      }
      const sessionId = (body.sessionId ?? '').trim();
      if (!sessionId) return json({ error: 'sessionId 必填' }, 400);
      const result = await gateway.bind(
        req.params.connectionId ?? '',
        decodeURIComponent(req.params.chatId ?? ''),
        sessionId,
      );
      return result.ok ? json({ ok: true }) : json({ error: result.reason ?? 'bind failed' }, 400);
    },
  });

  http({
    method: 'DELETE',
    path: '/bindings/:connectionId/:chatId',
    handler: async (req) => {
      const removed = await gateway.unbind(req.params.connectionId ?? '', decodeURIComponent(req.params.chatId ?? ''));
      return removed ? json({ ok: true }) : json({ error: 'binding not found' }, 404);
    },
  });

  // ── SSE：渠道日志 / 状态实时 feed（扫码进度也走这条）──
  http({
    method: 'GET',
    path: '/events',
    handler: () => {
      const encoder = new TextEncoder();
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const write = (event: string, data: unknown): void => {
            try {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            } catch {
              /* 客户端已断开：下一次 enqueue 会再次抛，交给 cancel 收尾 */
            }
          };
          // 先补一份近期日志，页面一打开就不是空白。
          for (const entry of gateway.recentLogs()) write('channel-log', entry);
          unsubscribe = gateway.onLog((entry) => write('channel-log', entry));
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(': ping\n\n'));
            } catch {
              /* ignore */
            }
          }, 15_000);
        },
        cancel() {
          unsubscribe?.();
          if (heartbeat) clearInterval(heartbeat);
        },
      });
      return new Response(stream, {
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
        },
      });
    },
  });
}
