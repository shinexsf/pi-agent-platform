/**
 * SSE events stream for a session.
 *
 * Forwarded from worker's WorkerEvent stream.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { WorkerPool } from '../worker-pool.js';
import type { WorkerEvent } from '@pi-agent-platform/ipc-protocol';

export function createEventsRouter(workerPool: WorkerPool) {
  const router = new Hono();

  router.get('/:id/events', (c) => {
    const sessionId = c.req.param('id');

    return streamSSE(c, async (stream) => {
      // Send a hello event so client knows the stream is alive.
      // Don't await — let handler continue to subscribe and wait for events.
      void stream.writeSSE({ event: 'connected', data: '{}' });

      // Subscribe to worker events (late-binds if worker not yet spawned).
      // Worker emits already-simplified MessageDeltaDTOs in `event.data`.
      const unsubscribe = workerPool.subscribe(sessionId, (event: WorkerEvent) => {
        // session_info_changed is master-internal (consumed to sync sessions.title
        // in index.ts) — not part of the SSE client contract (design D6).
        if (event.event === 'session_info_changed') return;
        void stream.writeSSE({
          event: event.event,
          id: (event.data as { messageId?: string } | undefined)?.messageId,
          data: JSON.stringify(event.data ?? {}),
        });
      });

      // Block until client disconnects
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener('abort', () => {
          unsubscribe();
          resolve();
        });
      });
    });
  });

  return router;
}