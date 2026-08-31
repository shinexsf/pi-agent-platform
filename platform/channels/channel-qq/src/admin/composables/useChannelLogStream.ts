/**
 * useChannelLogStream — subscribes to /api/im/events SSE stream and yields
 * ChannelLogEvent objects via the provided callback.
 *
 * Used by admin pages to display QR codes during WeChat login flow
 * (kind: 'qr-url') and any other host.logEvent() emissions.
 *
 * Returns a stop() function for cleanup.
 */
import type { ChannelLogEvent } from '@pi-agent-platform/channel-types';

export interface UseChannelLogStreamOptions {
  /** Filter events by channelId. Empty/undefined = listen to all. */
  channelId?: string;
  /** Called for each matching event. */
  onEvent: (event: ChannelLogEvent) => void;
  /** Called on stream error or close. */
  onError?: (err: Event) => void;
}

export function startChannelLogStream(opts: UseChannelLogStreamOptions): () => void {
  const url = new URL('/api/im/events', window.location.origin);
  if (opts.channelId) url.searchParams.set('channelId', opts.channelId);
  const es = new EventSource(url.toString());

  const handleMessage = (e: MessageEvent) => {
    try {
      const event = JSON.parse(e.data) as ChannelLogEvent;
      if (opts.channelId && event.channelId !== opts.channelId) return;
      opts.onEvent(event);
    } catch (err) {
      console.warn('[im-gateway] failed to parse log event:', err);
    }
  };

  // Listen to all event kinds (each logEvent with a kind gets its own event type).
  // We use onmessage as the default channel (server sends event:kind, but
  // EventSource also dispatches non-default kinds via addEventListener).
  es.onmessage = handleMessage;
  // Common kinds listened explicitly so EventSource triggers addEventListener
  // (not all kinds go through onmessage — depends on whether event: line
  // matches the default type).
  for (const kind of ['qr-url', 'qr-scanned', 'qr-expired', 'connected', 'start-failed', 'error', 'token-refreshed']) {
    es.addEventListener(kind, (e) => handleMessage(e as MessageEvent));
  }
  es.addEventListener('error', (e) => {
    opts.onError?.(e);
  });

  return () => {
    es.close();
  };
}