/**
 * useAttachments — handles upload + cache of user-pasted image attachments.
 *
 * Per-session cache of `{id, mimeType, dataB64}` rows. Used by:
 *  - InputBox.vue  → render pills + send with `attachedImages` to useSSE.send()
 *  - App.vue       → register global error -> toast on upload failure
 *
 * Server hard cap mirrors `MAX_ATTACHMENT_BYTES` in attachment-store.ts (25 MB).
 * Pre-upload check (10.7a) aborts fetching for files over the limit; the same
 * constant on server is the source of truth.
 */

import { ref } from 'vue'

export interface AttachmentSession {
  sessionId: string
}

export interface AttachmentToast {
  notify(message: string, level: 'info' | 'error'): void
}

/** Server-issued value. Mirror of `MAX_ATTACHMENT_BYTES` in attachment-store.ts.
 *  Bumping this here MUST be matched on server (and vice versa). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

export interface UploadedAttachment {
  /** "att_xxxxxxxxxxxxx" — the server-issued id. */
  id: string
  mimeType: string
  /** Base64-encoded raw image bytes. Same value we'll send to useSSE.send as `attachedImages[i].data`. */
  dataB64: string
  sizeBytes: number
  originalFilename: string
  /** `<file>` tag to insert into message text. */
  fileTag: string
}

export interface ToastHandle extends AttachmentToast {}

/** Convert a Blob to base64 without the data-URL prefix. */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('FileReader did not return string'))
        return
      }
      // Strip `data:<mime>;base64,` prefix if present; we want raw base64 only.
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

export function useAttachments(
  sessionCtx: AttachmentSession,
  toast: AttachmentToast,
) {
  const attaching = ref(false)
  const error = ref<string | null>(null)
  /** Per-session cache. Keyed by attachment id. Cleanup happens implicitly when
   *  the chat tab unmounts — no persistent storage needed for v1. */
  const cache = new Map<string, UploadedAttachment>()

  /** Get a snapshot list of all cached attachments for the active session.
   *  Used by InputBox at send-time. */
  function listForSend(): UploadedAttachment[] {
    // Cache is implicitly cleared at tab-close; v1 doesn't persist.
    return Array.from(cache.values())
  }

  async function uploadImage(file: File): Promise<UploadedAttachment | null> {
    error.value = null

    // Pre-upload size guard (task 10.7a). Mirror of server's MAX_ATTACHMENT_BYTES.
    if (file.size > MAX_ATTACHMENT_BYTES) {
      const msg = `Image "${file.name || 'pasted'}" exceeds 25 MB limit; not uploaded.`
      error.value = msg
      toast.notify(msg, 'error')
      return null
    }
    if (file.size === 0) {
      const msg = `Image "${file.name || 'pasted'}" is empty; skipping.`
      toast.notify(msg, 'error')
      return null
    }

    attaching.value = true
    try {
      const dataB64 = await blobToBase64(file)
      const res = await fetch(`/api/sessions/${sessionCtx.sessionId}/attachments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data: dataB64,
          filename: file.name || '',
          mimeType: file.type || '',
        }),
      })
      if (!res.ok) {
        const reason = `Upload failed (${res.status}) for "${file.name || 'pasted'}"`
        try {
          const body = (await res.json()) as { error?: string }
          if (body?.error) error.value = `${reason}: ${body.error}`
          else error.value = reason
        } catch {
          error.value = reason
        }
        toast.notify(error.value, 'error')
        return null
      }
      const json = (await res.json()) as {
        id: string
        mimeType: string
        sizeBytes: number
        originalFilename: string
        fileTag: string
      }
      const entry: UploadedAttachment = {
        id: json.id,
        mimeType: json.mimeType,
        dataB64,
        sizeBytes: json.sizeBytes,
        originalFilename: json.originalFilename || file.name || 'pasted',
        fileTag: json.fileTag,
      }
      cache.set(entry.id, entry)
      return entry
    } catch (err) {
      const msg = `Upload error: ${(err as Error).message}`
      error.value = msg
      toast.notify(msg, 'error')
      return null
    } finally {
      attaching.value = false
    }
  }

  /** Drop one cached row (called by InputBox pill X). */
  function forget(id: string): void {
    cache.delete(id)
  }

  /** Clear all (e.g. on session switch — not currently bound but available). */
  function clear(): void {
    cache.clear()
  }

  return {
    attaching,
    error,
    uploadImage,
    forget,
    clear,
    listForSend,
    /** Test utility / future: resolve an `att_xxx` id to its dataB64 (used
     *  by client-side marker parsing if Option B is ever revisited). */
    resolve(id: string): UploadedAttachment | undefined {
      return cache.get(id)
    },
  }
}
