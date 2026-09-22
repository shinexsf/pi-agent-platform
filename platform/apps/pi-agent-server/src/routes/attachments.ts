/**
 * Image attachment routes:
 *   POST /api/sessions/:id/attachments — upload user-pasted image (idempotent by content-addressed sha)
 *   GET  /api/sessions/:id/attachments — list session attachments (metadata only, no path)
 *
 * NOTE: read-tool images do NOT flow through these endpoints. See
 * `openspec/changes/image-attachments-via-server/specs/image-attachments-api/spec.md`
 * for the user-attachment boundary.
 */

import { Hono } from 'hono';
import type { SessionRepo } from '../repos/session.repo.js';
import type { WorkerPool } from '../worker-pool.js';
import { childLogger } from '../logger.js';

const logger = childLogger('attachments');
import {
  AttachmentStore,
  MAX_ATTACHMENT_BYTES,
  sha256Hex,
  fileTag,
} from '../services/attachment-store.js';

interface AttachmentsRouterDeps {
  sessionRepo: SessionRepo;
  workerPool: WorkerPool;
  attachmentStore: AttachmentStore;
}

/** Magic-byte sniffer covering PNG, JPEG, GIF, WebP. Returns lowercase mime or null. */
function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  // GIF: GIF87a / GIF89a
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
      && (bytes[4] === 0x39 || bytes[4] === 0x37) && bytes[5] === 0x61) {
    return 'image/gif';
  }
  // WebP: RIFF .... WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

interface UploadBody {
  /** Base64-encoded image bytes (raw content, NOT a data URL). */
  data?: unknown;
  /** Optional client-provided filename (best-effort). */
  filename?: unknown;
  /** Optional client-asserted mimeType; we still verify via magic bytes. */
  mimeType?: unknown;
}

export function createAttachmentsRouter(deps: AttachmentsRouterDeps) {
  const { sessionRepo, workerPool, attachmentStore } = deps;

  const router = new Hono();

  // POST /api/sessions/:id/attachments — upload one image.
  // Accepts BOTH real sessions (DB row exists) AND placeholder sessions
  // (created by POST /api/sessions/agents/:agentId but no prompt yet) —
  // identified by checking if a worker is alive for the session. This is
  // required for the IDE flow: open chat tab → paste image (upload before
  // first prompt) → type text → send prompt (DB row materializes).
  const sessionIsLive = (id: string): boolean => {
    if (sessionRepo.get(id)) return true;
    return workerPool.has(id);
  };

  router.post('/:id/attachments', async (c) => {
    const id = c.req.param('id');
    if (!sessionIsLive(id)) {
      return c.json({ error: 'Session not found', code: 'session_not_found' }, 404);
    }

    let body: UploadBody;
    try {
      body = await c.req.json<UploadBody>();
    } catch {
      return c.json({ error: 'Invalid JSON body', code: 'invalid_body' }, 400);
    }

    if (typeof body.data !== 'string' || body.data.length === 0) {
      return c.json({ error: 'Missing data (base64 string required)', code: 'invalid_body' }, 400);
    }

    let bytes: Uint8Array;
    try {
      // Buffer.from with base64 strips whitespace; safe for raw b64 without padding adjustments.
      const buf = Buffer.from(body.data, 'base64');
      bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      return c.json({ error: 'data is not valid base64', code: 'invalid_body' }, 400);
    }

    // Hard cap (spec §"客户端预校验对齐服务端上限"). Cheaper than waiting for fs.writeFile partial.
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return c.json(
        { error: 'File too large', code: 'file_too_large', maxBytes: MAX_ATTACHMENT_BYTES },
        413,
      );
    }
    if (bytes.byteLength === 0) {
      return c.json({ error: 'Empty file', code: 'invalid_body' }, 400);
    }

    // Magic-byte sniff for images; fallback to client-claimed mimeType or octet-stream.
    const sniffedMime = detectImageMime(bytes);
    const mimeType = sniffedMime
      ?? (typeof body.mimeType === 'string' && body.mimeType ? body.mimeType : 'application/octet-stream');
    const originalFilename =
      typeof body.filename === 'string' && body.filename.trim().length > 0
        ? body.filename.trim().slice(0, 255)
        : '';

    try {
      const result = await attachmentStore.upsert({
        sessionId: id,
        bytes,
        mimeType,
        originalFilename,
      });
      return c.json({
        id: result.row.id,
        mimeType: result.row.mimeType,
        sizeBytes: result.row.sizeBytes,
        originalFilename: result.row.originalFilename,
        sha256: result.row.sha,
        createdAt: result.row.createdAt,
        fileTag: fileTag(result.row, result.row.originalFilename),
      });
    } catch (err) {
      const code = (err as Error & { code?: string }).code;
      if (code === 'file_too_large') {
        // Race against the per-call cap above — defensive; should never trigger here.
        return c.json(
          { error: 'File too large', code: 'file_too_large', maxBytes: MAX_ATTACHMENT_BYTES },
          413,
        );
      }
      logger.warn({ err, sessionId: id }, 'upload failed');
      return c.json({ error: 'Internal upload error', code: 'internal' }, 500);
    }
  });

  // GET /api/sessions/:id/attachments — list metadata, newest first
  router.get('/:id/attachments', async (c) => {
    const id = c.req.param('id');
    if (!sessionIsLive(id)) {
      return c.json({ error: 'Session not found', code: 'session_not_found' }, 404);
    }
    const rows = attachmentStore.listBySession(id);
    return c.json(
      rows.map((r) => ({
        id: r.id,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        originalFilename: r.originalFilename,
        createdAt: r.createdAt,
      })),
    );
  });

  // GET /api/sessions/:id/attachments/:attId — serve attachment file bytes
  router.get('/:id/attachments/:attId', async (c) => {
    const sessionId = c.req.param('id');
    const attId = c.req.param('attId');
    if (!sessionIsLive(sessionId)) {
      return c.json({ error: 'Session not found', code: 'session_not_found' }, 404);
    }
    const row = attachmentStore.lookupById(sessionId, attId);
    if (!row) {
      return c.json({ error: 'Attachment not found', code: 'not_found' }, 404);
    }
    // Read file from disk and return as binary
    const fs = await import('node:fs/promises');
    const filePath = attachmentStore.resolvePath(sessionId, row.filename);
    try {
      const bytes = await fs.readFile(filePath);
      return new Response(bytes, {
        headers: {
          'Content-Type': row.mimeType,
          'Content-Length': String(bytes.byteLength),
          'Cache-Control': 'public, max-age=31536000, immutable',
        },
      });
    } catch {
      return c.json({ error: 'File not found on disk', code: 'file_missing' }, 404);
    }
  });

  return router;
}

/** Re-export helper used by tests / harness to pre-compute sha (rare). */
export { sha256Hex };
