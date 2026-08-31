/**
 * Unified IDE bridge accessor + event subscription.
 *
 * Per D5 (bridge `on()` real implementation):
 *   - Listener ID managed by Kotlin side (returned via `__onViaBridge(event)` IPC).
 *   - JS-side dispatch table `window.__ideBridgeListeners[listenerId]` maps to callback.
 *   - Kotlin `__ideBridgeOnEvent(listenerId, data)` triggers the matching listener.
 *   - Unsubscribe removes both JS + Kotlin entries.
 */

import type { IdeBridge } from '../bridge/ide-bridge'
import { webFallbackBridge } from '../bridge/web-fallback'

let cached: IdeBridge | null = null

export function useIdeBridge(): IdeBridge {
  if (cached) return cached
  if (typeof window !== 'undefined' && window.__ideBridge) {
    cached = window.__ideBridge
    return cached
  }
  cached = webFallbackBridge
  return cached
}

/**
 * Wait for `ide-bridge-ready` then return the bridge.
 * Vue components onMounted should call this before using bridge methods.
 */
export function onIdeBridgeReady(callback: (bridge: IdeBridge) => void): () => void {
  if (typeof window === 'undefined') return () => {}

  if (window.__ideBridgeReady && window.__ideBridge) {
    callback(window.__ideBridge)
    return () => {}
  }

  const handler = () => {
    if (window.__ideBridge) {
      // refresh getIdeBridge cache
      cached = window.__ideBridge
      callback(window.__ideBridge)
    }
    window.removeEventListener('ide-bridge-ready', handler)
  }
  window.addEventListener('ide-bridge-ready', handler)

  return () => window.removeEventListener('ide-bridge-ready', handler)
}