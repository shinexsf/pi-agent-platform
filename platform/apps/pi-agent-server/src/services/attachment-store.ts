/**
 * AttachmentStore — server-side image attachment storage for user-pasted images.
 *
 * Storage layout: <attachmentsDir>/<sessionId>/<sha>.<ext>
 *   - sha = lowercase hex of sha256 over the raw bytes
 *   - ext derived from mimeType (image/png → png, image/jpeg → jpg, etc.)
 *   - files written under <attachmentsDir>/<sessionId>/ so a session delete
 *     can `rm -rf` a whole subdir to reclaim everything atomically.
 *
 * NOTE: read-tool images do NOT flow through this store. They are owned by
 * the source filesystem path the model chose to read. See the spec at
 * `openspec/changes/image-attachments-via-server/specs/session-deletion-cascade-attachments`
 * for the boundary rules.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/init.js';
import { attachments, type attachments as attachmentsTable } from '../db/schema.js';

/** Hard cap on raw byte count of any single attachment. Matches the spec at
 *  `image-attachments-api/spec.md` §"客户端预校验对齐服务端上限".
 *  Client-side upload MUST pre-check against this same value (see tasks 10.7a/10.7b). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Supported mimeType whitelist. Anything else → unsupported_mime rejection.
 *  HD formats (HEIC etc.) are auto-converted to PNG by pi SDK's processImage at
 *  prompt-time, but only when the original bytes are valid + already-supplied. */
const SUPPORTED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Map MIME → file extension. lowercase mime bytes drive ext. */
function extForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    default: return 'bin';
  }
}

/** Lowercase SHA-256 hex digest of bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Convert sha256 hex to a fixed-width 13-char lowercase base32 (RFC 4648) string.
 *  Used as the suffix of `att_` IDs — full 13 chars are required for the
 *  server-side marker regex `/\[pi-attachment:(att_[a-z2-7]{13})\]/g` to match.
 *  Bug history (R11): a previous version only streamed 8 bytes (64 bits) and
 *  emitted 12 chars, breaking marker extraction. Encoding now pulls 9 bytes
 *  (72 bits, first 18 hex chars) and always emits 13 chars. */
export function attIdFromSha(sha: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'; // RFC 4648 lowercase
  // First 18 hex chars = 9 bytes = 72 bits. 13 chars × 5 bits = 65 bits used;
  // 7 bits remain buffered (don't affect the produced output).
  const hex = sha.slice(0, 18);
  let bits = 0, value = 0, out = '';
  for (let i = 0; i + 1 < hex.length && out.length < 13; i += 2) {
    const v = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(v)) continue;
    value = (value << 8) | v;
    bits += 8;
    while (bits >= 5 && out.length < 13) {
      bits -= 5;
      out += alphabet[(value >>> bits) & 0x1f];
    }
  }
  // Defensive: if input was malformed, pad with alphabet[0] = 'a'.
  while (out.length < 13) out += alphabet[0];
  return out;
}

export interface AttachmentRow {
  /** Client-facing ID, e.g. "att_5f4dcc3b5aa7". */
  id: string;
  /** Server-side content hash (lowercase hex). */
  sha: string;
  sessionId: string;
  mimeType: string;
  originalFilename: string;
  sizeBytes: number;
  createdAt: number;
}

export interface AttachmentWriteResult {
  row: AttachmentRow;
  /** True when this call did NOT touch the filesystem (file already present from earlier upload). */
  alreadyExisted: boolean;
}

export interface AttachmentLookupForPromptResult {
  id: string;
  sha: string;
  mimeType: string;
  /** Absolute path on disk. Provided for the worker IPC contract. */
  path: string;
}

export class AttachmentStore {
  constructor(
    private readonly db: DB,
    private readonly attachmentsDir: string,
  ) {}

  /**
   * Idempotently write an attachment to disk + insert/update DB row.
   *
   * - Re-upload with the same (sessionId, sha) returns the existing row without
   *   re-writing the file (content-addressed dedupe within a session).
   * - Cross-session: same sha in different sessions creates two file copies +
   *   two DB rows (sessions own their bytes independently).
   */
  async upsert(input: {
    sessionId: string;
    bytes: Uint8Array;
    mimeType: string;
    originalFilename: string;
  }): Promise<AttachmentWriteResult> {
    const { sessionId, bytes, mimeType, originalFilename } = input;
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      const err = new Error('File too large');
      (err as Error & { code: string }).code = 'file_too_large';
      (err as Error & { maxBytes: number }).maxBytes = MAX_ATTACHMENT_BYTES;
      throw err;
    }
    const sha = sha256Hex(bytes);
    const ext = extForMimeType(mimeType);
    const sessionDir = path.join(this.attachmentsDir, sessionId);
    const filePath = path.join(sessionDir, `${sha}.${ext}`);

    // Fast path: row + file already present → return existing.
    const existing = this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.sessionId, sessionId), eq(attachments.sha, sha)))
      .get();
    if (existing) {
      return {
        row: rowToDTO(existing),
        alreadyExisted: true,
      };
    }

    await mkdir(sessionDir, { recursive: true });
    await writeFile(filePath, bytes);

    const id = `att_${attIdFromSha(sha)}`;
    const createdAt = Date.now();
    const sizeBytes = bytes.byteLength;

    this.db
      .insert(attachments)
      .values({
        sessionId,
        sha,
        id,
        mimeType,
        originalFilename,
        sizeBytes,
        createdAt,
      })
      .run();

    return {
      row: { id, sha, sessionId, mimeType, originalFilename, sizeBytes, createdAt },
      alreadyExisted: false,
    };
  }

  /** List attachments for a session, newest first. Used by `GET /api/sessions/:id/attachments`. */
  listBySession(sessionId: string): AttachmentRow[] {
    const rows = this.db
      .select()
      .from(attachments)
      .where(eq(attachments.sessionId, sessionId))
      .orderBy(desc(attachments.createdAt))
      .all();
    return rows.map(rowToDTO);
  }

  /**
   * Lookup attachments by `att_*` IDs for the prompt route. Returns:
   *   - exactly the rows that exist (subset of input ids)
   *   - absolute path on disk for worker IPC
   *
   * Caller (route) is responsible for distinguishing "missing ids" vs "found ids"
   * (input ids - returned ids = missingIds for 400 response).
   */
  lookupForPrompt(sessionId: string, ids: string[]): AttachmentLookupForPromptResult[] {
    if (ids.length === 0) return [];
    const rows = this.db
      .select()
      .from(attachments)
      .where(and(eq(attachments.sessionId, sessionId), inArray(attachments.id, ids)))
      .all();
    return rows.map((r) => {
      const ext = extForMimeType(r.mimeType);
      return {
        id: r.id,
        sha: r.sha,
        mimeType: r.mimeType,
        path: path.join(this.attachmentsDir, r.sessionId, `${r.sha}.${ext}`),
      };
    });
  }

  /**
   * Cascade-delete DB rows + directory for a session.
   *
   * Order is **DB-first**: rows are authoritative (UI only sees attachments via DB
   * lookup); file removal is best-effort. If fs.rm fails, log warn; the caller
   * should still treat this as success (rows already gone = the truth).
   *
   * Returns the number of DB rows deleted (= attachments_deleted in cascade response).
   */
  async deleteBySession(sessionId: string): Promise<{ rowsDeleted: number }> {
    const result = this.db
      .delete(attachments)
      .where(eq(attachments.sessionId, sessionId))
      .run();
    const dir = path.join(this.attachmentsDir, sessionId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      // Best-effort. Logged here; the DB delete already happened. Orphan files
      // are detectable via `du` on the attachments root — not a correctness issue.
      console.warn(
        `[attachment-store] cascade: failed to rm ${dir}: ${(err as Error).message}. ` +
        `DB rows (${result.changes}) already deleted; orphan files may remain.`,
      );
    }
    return { rowsDeleted: result.changes };
  }

  /** True if this mimeType is supported for upload. */
  static isSupportedMimeType(mime: string): boolean {
    return SUPPORTED_MIME_TYPES.has(mime);
  }
}

function rowToDTO(row: typeof attachmentsTable.$inferSelect): AttachmentRow {
  return {
    id: row.id,
    sha: row.sha,
    sessionId: row.sessionId,
    mimeType: row.mimeType,
    originalFilename: row.originalFilename,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
  };
}

/** Helper used by routes/attachments to map unsupported mimeTypes to a 415. */
export const SUPPORTED_MIME_TYPES_READONLY = SUPPORTED_MIME_TYPES;
export { extForMimeType };

/** Quick test-only utility: remove a single file (used in tests + internal cleanup). */
export async function unlinkFile(filePath: string): Promise<void> {
  await unlink(filePath);
}
