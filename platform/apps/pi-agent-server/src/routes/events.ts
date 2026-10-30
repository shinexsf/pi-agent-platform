/**
 * SSE events stream for a session.
 *
 * Forwarded from the session's Session object (which forwards the pool's
 * `session_event` emitter). Core-session-refactor 2.4/2.5:
 * - subscribe goes through Session (track() anchors a workerless object so a
 *   dead session can still be subscribed to — events flow once a worker exists)
 * - on dispose (worker death / delete / timeout / LRU) the registry notifies
 *   subscribers → we write a final `session_disposed` event and CLOSE the
 *   stream; the client's EventSource auto-reconnects and re-subscribes to the
 *   next object (spec: dispose 通知并清除订阅者，重连后消息流恢复)
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { WorkerEvent } from '@pi-agent-platform/ipc-protocol';
import type { SessionRunState } from '@pi-agent-platform/shared-types';
import { sessionRegistry } from '../services/session.js';
import type { Session } from '../services/session.js';
import { childLogger } from '../logger.js';

const logger = childLogger('plugin-events');

/** 插件事件硬上限（节流责任归插件，这里只保证平台不被拖死）。 */
export const PLUGIN_EVENT_MAX_BYTES = 64 * 1024;
export const PLUGIN_EVENT_MAX_PER_SEC = 100;

interface PluginRateWindow {
  sec: number;
  count: number;
  dropWarned: boolean;
}

const pluginRate = new Map<string, PluginRateWindow>();

/** 每秒最多 PLUGIN_EVENT_MAX_PER_SEC 条；超限丢弃，每秒至多告警一次。 */
function allowPluginEvent(sessionId: string): boolean {
  const sec = Math.floor(Date.now() / 1000);
  const cur = pluginRate.get(sessionId);
  if (!cur || cur.sec !== sec) {
    pluginRate.set(sessionId, { sec, count: 1, dropWarned: false });
    return true;
  }
  if (cur.count >= PLUGIN_EVENT_MAX_PER_SEC) {
    if (!cur.dropWarned) {
      cur.dropWarned = true;
      logger.warn({ sessionId, limit: PLUGIN_EVENT_MAX_PER_SEC }, 'plugin event rate limit hit — dropping the rest of this second');
    }
    return false;
  }
  cur.count += 1;
  return true;
}

/** 同一会话同一秒内只在首次超限/截断时告警，避免日志风暴。 */
const pluginWarnMark = new Map<string, number>();
function warnPluginOnce(sessionId: string, reason: 'payload' | 'rate', extra: Record<string, unknown>): void {
  const sec = Math.floor(Date.now() / 1000);
  const key = `${sessionId}:${reason}`;
  if (pluginWarnMark.get(key) === sec) return;
  pluginWarnMark.set(key, sec);
  logger.warn({ sessionId, reason, ...extra }, 'plugin event rejected');
}

/**
 * `session_snapshot` payload: the run-state subset a late subscriber needs.
 * Deliberately does NOT include the in-flight message body — replaying a partial
 * stream is out of scope (see proposal Non-goals).
 */
interface SessionSnapshotData {
  running: boolean;
  startedAt: number | null;
  pendingSteer: number;
  pendingFollowUp: number;
}

function snapshotOf(session: Session): SessionSnapshotData {
  const run: SessionRunState = session.run;
  return {
    running: run.status === 'running',
    startedAt: run.startedAt,
    pendingSteer: run.pendingSteer,
    pendingFollowUp: run.pendingFollowUp,
  };
}

export function createEventsRouter() {
  const router = new Hono();

  router.get('/:id/events', (c) => {
    const sessionId = c.req.param('id');

    return streamSSE(c, async (stream) => {
      // Send a hello event so client knows the stream is alive.
      // Don't await — let handler continue to subscribe and wait for events.
      void stream.writeSSE({ event: 'connected', data: '{}' });

      // Workerless anchor: subscribing must NOT spawn a worker; getOrCreate
      // reuses this object when the next prompt revives the session.
      const session = sessionRegistry().track(sessionId);

      let finish!: () => void;
      const disposed = new Promise<void>((resolve) => {
        finish = resolve;
      });

      const unsubscribe = session.subscribe(
        (event: WorkerEvent) => {
          // session_info_changed is master-internal (consumed to sync sessions.title
          // in index.ts) — not part of the SSE client contract (design D6).
          if (event.event === 'session_info_changed') return;
          // 插件事件：事件名改写为 `plugin.<id>.<name>`，载荷原样；带硬上限兜底
          // （节流责任归插件，平台只保证自己不被拖死）。
          if (event.event === 'plugin_event') {
            const payload = event.data as { pluginId?: string; name?: string; data?: unknown } | undefined;
            const pluginId = payload?.pluginId ?? '(unknown)';
            const name = payload?.name ?? '(unnamed)';
            if (!allowPluginEvent(sessionId)) {
              warnPluginOnce(sessionId, 'rate', { pluginId, name });
              return;
            }
            let serialized: string;
            try {
              serialized = JSON.stringify(payload?.data ?? {});
            } catch {
              serialized = '"' + '[unserializable plugin payload]' + '"';
            }
            const bytes = Buffer.byteLength(serialized, 'utf8');
            if (bytes > PLUGIN_EVENT_MAX_BYTES) {
              warnPluginOnce(sessionId, 'payload', { pluginId, name, bytes });
              serialized = JSON.stringify({ truncated: true, bytes });
            }
            // 固定事件名 `plugin`，插件身份放在载荷里：浏览器端只需挂一个监听器，
            // 不必为每个 `plugin.<id>.<name>` 动态 addEventListener（EventSource
            // 只对无名事件走 message，动态名无法通配）。
            void stream.writeSSE({
              event: 'plugin',
              data: `{"pluginId":${JSON.stringify(pluginId)},"name":${JSON.stringify(name)},"data":${serialized}}`,
            });
            return;
          }
          void stream.writeSSE({
            event: event.event,
            id: (event.data as { messageId?: string } | undefined)?.messageId,
            data: JSON.stringify(event.data ?? {}),
          });
        },
        (reason) => {
          // Terminal: tell the client, then close so EventSource reconnects.
          // Guarded — the stream may already be gone (client aborted first).
          try {
            // A dead worker cannot be running: clear the client's run state before
            // closing, otherwise a reconnecting client would re-learn idle only
            // from the next snapshot.
            void stream.writeSSE({ event: 'session_snapshot', data: JSON.stringify(snapshotOf(session)) });
            void stream.writeSSE({ event: 'session_disposed', data: JSON.stringify({ reason }) });
          } catch {
            /* stream already closed */
          }
          finish();
        },
      );

      // Snapshot AFTER subscribing and in the SAME tick: no event can interleave, so a
      // client connecting mid-run learns the authoritative run state without missing
      // anything that follows. `connected` already told it the stream is alive.
      void stream.writeSSE({ event: 'session_snapshot', data: JSON.stringify(snapshotOf(session)) });

      // Block until client disconnects (abort) OR the session object is
      // disposed (worker death / delete / timeout / LRU).
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => resolve());
        void disposed.then(() => resolve());
      });
      unsubscribe();
    });
  });

  return router;
}
