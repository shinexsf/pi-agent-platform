/**
 * useSSE — typed SSE client composable.
 *
 * Returns a controller with on/off event handlers, connect/disconnect lifecycle,
 * and automatic reconnect with exponential backoff.
 */

import { onBeforeUnmount } from 'vue';

export type SSEHandler = (data: unknown) => void;

export interface SSEController {
  on(event: string, handler: SSEHandler): void;
  off(event: string, handler: SSEHandler): void;
  connect(): void;
  disconnect(): void;
}

export function useSSE(url: string): SSEController {
  let es: EventSource | null = null;
  const handlers = new Map<string, Set<SSEHandler>>();
  let retryDelay = 1000;
  let closed = false;

  function dispatch(event: string, data: unknown) {
    const set = handlers.get(event);
    if (!set) return;
    for (const h of set) {
      try {
        h(data);
      } catch (err) {
        console.error(`[sse] handler error for event "${event}":`, err);
      }
    }
  }

  function open() {
    if (closed) return;
    es = new EventSource(url);

    // Native events (connect/error/ping)
    es.addEventListener('connected', () => {
      retryDelay = 1000;
      dispatch('connected', null);
    });
    es.addEventListener('error', () => {
      dispatch('error', null);
      es?.close();
      es = null;
      if (closed) return;
      // Reconnect with exponential backoff (cap at 30s)
      const delay = retryDelay;
      retryDelay = Math.min(retryDelay * 2, 30_000);
      setTimeout(open, delay);
    });

    // Forward all named events to handlers
    for (const eventName of handlers.keys()) {
      if (eventName === 'connected' || eventName === 'error' || eventName === 'open') continue;
      es.addEventListener(eventName, (e: MessageEvent) => {
        try {
          const data = e.data ? JSON.parse(e.data) : null;
          dispatch(eventName, data);
        } catch (err) {
          console.error(`[sse] failed to parse event "${eventName}" data:`, err);
        }
      });
    }
  }

  onBeforeUnmount(() => {
    closed = true;
    es?.close();
    es = null;
  });

  return {
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      // If already connected, attach a real listener to the existing EventSource
      if (es && event !== 'connected' && event !== 'error' && event !== 'open') {
        es.addEventListener(event, (e: MessageEvent) => {
          try {
            const data = e.data ? JSON.parse(e.data) : null;
            dispatch(event, data);
          } catch (err) {
            console.error(`[sse] late-attach parse error:`, err);
          }
        });
      }
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    connect: open,
    disconnect() {
      closed = true;
      es?.close();
      es = null;
    },
  };
}