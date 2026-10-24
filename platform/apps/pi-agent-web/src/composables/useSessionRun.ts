/**
 * Session run state (change: session-streaming-runtime, design D3).
 *
 * The authoritative answer to "is a turn running right now", fed by:
 *   - `session_snapshot` (sent by the server right after the SSE stream connects,
 *     and once more when the session is disposed)
 *   - `agent_start` / `agent_settled` lifecycle events
 *   - `SessionContextDTO.run` when the chat page loads (mid-run reload case)
 *
 * `sending` in useSSE stays as optimistic UI only; this state wins whenever both
 * are known (a page reload during a run must show a running spinner, and a settle
 * event must stop it even if the local flag is stale).
 */

import { computed, onUnmounted, ref } from 'vue'
import type { SessionRunState } from '@pi-agent-platform/shared-types'

/** Frame the server writes right after SSE `connected`. */
export interface SessionSnapshotFrame {
  running: boolean
  startedAt: number | null
  pendingSteer: number
  pendingFollowUp: number
}

export function useSessionRun() {
  const status = ref<'idle' | 'running'>('idle')
  const startedAt = ref<number | null>(null)
  const pendingSteer = ref(0)
  const pendingFollowUp = ref(0)

  // Local clock for elapsed rendering. Ticks ONLY while running (interval 250ms is
  // enough for a seconds-level counter) so an idle page has zero timers.
  const now = ref(Date.now())
  let ticker: ReturnType<typeof setInterval> | null = null

  const running = computed(() => status.value === 'running')
  const elapsedMs = computed(() =>
    running.value && startedAt.value !== null ? Math.max(0, now.value - startedAt.value) : 0,
  )

  function startTicker() {
    if (ticker !== null) return
    now.value = Date.now()
    ticker = setInterval(() => {
      now.value = Date.now()
    }, 250)
  }

  function stopTicker() {
    if (ticker === null) return
    clearInterval(ticker)
    ticker = null
  }

  function applyState(next: SessionRunState) {
    status.value = next.status
    startedAt.value = next.startedAt ?? null
    pendingSteer.value = next.pendingSteer ?? 0
    pendingFollowUp.value = next.pendingFollowUp ?? 0
    if (next.status === 'running') startTicker()
    else stopTicker()
  }

  /** `session_snapshot` frame — authoritative, overwrite everything. */
  function applySnapshot(frame: SessionSnapshotFrame) {
    applyState({
      status: frame.running ? 'running' : 'idle',
      startedAt: frame.running ? (frame.startedAt ?? Date.now()) : null,
      pendingSteer: frame.pendingSteer ?? 0,
      pendingFollowUp: frame.pendingFollowUp ?? 0,
    })
  }

  /** `SessionContextDTO.run` — seed state on chat page load. */
  function applyContextRun(run: SessionRunState | undefined) {
    if (!run) return
    applyState(run)
  }

  function markStart(at?: number) {
    applyState({
      status: 'running',
      startedAt: typeof at === 'number' ? at : Date.now(),
      pendingSteer: pendingSteer.value,
      pendingFollowUp: pendingFollowUp.value,
    })
  }

  function markSettled() {
    applyState({ status: 'idle', startedAt: null, pendingSteer: 0, pendingFollowUp: 0 })
  }

  function markDisposed() {
    markSettled()
  }

  function setPending(next: { steer?: number; followUp?: number }) {
    if (next.steer !== undefined) pendingSteer.value = next.steer
    if (next.followUp !== undefined) pendingFollowUp.value = next.followUp
  }

  onUnmounted(stopTicker)

  return {
    status,
    startedAt,
    pendingSteer,
    pendingFollowUp,
    running,
    elapsedMs,
    applyState,
    applySnapshot,
    applyContextRun,
    markStart,
    markSettled,
    markDisposed,
    setPending,
  }
}

export type UseSessionRun = ReturnType<typeof useSessionRun>
