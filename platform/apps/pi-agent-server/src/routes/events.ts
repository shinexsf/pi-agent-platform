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
import { sessionRegistry } from '../services/session.js';

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
            void stream.writeSSE({ event: 'session_disposed', data: JSON.stringify({ reason }) });
          } catch {
            /* stream already closed */
          }
          finish();
        },
      );

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
