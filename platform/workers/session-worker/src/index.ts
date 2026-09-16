/**
 * Worker entry point.
 *
 * Receives CallRequest messages from master via process IPC channel (process.send / on('message')).
 * Sends CallResponse and WorkerEvent back.
 *
 * Lifecycle:
 * 1. Send 'ready' event (master checks this within 200ms)
 * 2. Handle calls until process exit
 */

import process from 'node:process';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  CallRequest,
  CallResponse,
  WorkerEvent,
  WorkerMethod,
} from '@pi-agent-platform/ipc-protocol';
import type { RuntimeConfig } from '@pi-agent-platform/shared-types';
// pi-coding-agent's `processImage` is not exposed via the package's main export
// map, but its two building blocks (resizeImage + formatDimensionNote) ARE.
// Server only uploads PNG/JPEG/GIF/WebP (mimeType validation), so we skip
// the format-conversion step (which would need `convertImageBytesToPng`,
// also not exported). The worker-side pipeline below mirrors pi SDK's
// processImage for the supported mime whitelist — see
// `processImage` in @earendil-works/pi-coding-agent/dist/utils/image-process.ts.
import { resizeImage, formatDimensionNote } from '@earendil-works/pi-coding-agent';
import { createSession, PiSessionAdapter } from './session.js';

// State
let currentSession: PiSessionAdapter | null = null;
let currentHandle: string | null = null;
// ---------- emit helper ----------
function emit(event: Omit<WorkerEvent, 'kind'>): void {
  const wire: WorkerEvent = { kind: 'event', ...event };
  if (process.send) {
    process.send(wire);
  }
}

function respond(id: number, ok: boolean, resultOrError: unknown): void {
  const wire: CallResponse = ok
    ? { kind: 'response', id, ok: true, result: resultOrError }
    : {
        kind: 'response',
        id,
        ok: false,
        error: {
          message:
            resultOrError instanceof Error
              ? resultOrError.message
              : String(resultOrError),
          stack: resultOrError instanceof Error ? resultOrError.stack : undefined,
        },
      };
  if (process.send) {
    process.send(wire);
  }
}

// ---------- dispatch ----------
async function dispatch(req: CallRequest): Promise<void> {
  const method = req.method;
  const args = req.args;

  try {
    switch (method as WorkerMethod) {
      case 'createSession': {
        const [config, sessionId, existingSessionPath] = args as [RuntimeConfig, string, string | undefined];
        console.log(`[worker] received createSession sessionId=${sessionId}`)
        const { session, handle } = await createSession(config, sessionId, emit, existingSessionPath);
        currentSession = session;
        currentHandle = handle.id;
        console.log(`[worker] session ready sessionId=${sessionId} handle=${handle.id} piSessionPath=${handle.piSessionPath} model=${handle.model ? `${handle.model.provider}/${handle.model.modelId}` : '(default)'}`)
        respond(req.id, true, { sessionHandle: handle.id, piSessionPath: handle.piSessionPath, model: handle.model, thinkingLevel: handle.thinkingLevel });
        return;
      }
      case 'prompt': {
        if (!currentSession) throw new Error('no active session');
        const [message, promptOptions] = args as [
          string,
          {
            streamingBehavior?: 'steer' | 'followUp';
            attachments?: Array<{ id: string; sha: string; mimeType: string; filename: string; originalFilename: string }>;
          }?,
        ];
        if (!promptOptions?.attachments || promptOptions.attachments.length === 0) {
          // No attachments — pass through to existing session.prompt path.
          await currentSession.prompt(message, { streamingBehavior: promptOptions?.streamingBehavior });
          respond(req.id, true, null);
          return;
        }
        // Resolve each attachment: images → base64 via processImage pipeline,
        // non-images → <file path> tag prompting agent to read.
        const images: Array<{ type: 'image'; mimeType: string; data: string }> = [];
        let augmentedText = message;
        for (const att of promptOptions.attachments) {
          const absPath = path.join(ATTACHMENTS_ROOT!, currentHandle ?? '', att.filename);

          // Branch: image vs non-image
          if (isImageMimeType(att.mimeType)) {
            // ── Image path: existing base64 pipeline ──
            let bytes: Uint8Array;
            try {
              bytes = readAttachmentBytes(currentHandle ?? '', att.filename, att.sha, att.mimeType);
            } catch (err) {
              console.warn(`[worker] skip image ${att.id}: ${(err as Error).message}`);
              const ext = extForMimeType(att.mimeType);
              augmentedText += `\n<file path="${absPath}">[attachment load failed: ${(err as Error).message}]</file>`;
              continue;
            }
            let processed;
            try {
              const resized = await resizeImage(bytes, att.mimeType);
              if (!resized) {
                processed = {
                  ok: false as const,
                  message: '[Image omitted: could not be resized below the inline image size limit.]',
                };
              } else {
                const hints: string[] = [];
                const dimensionNote = formatDimensionNote(resized);
                if (dimensionNote) hints.push(dimensionNote);
                processed = {
                  ok: true as const,
                  data: resized.data,
                  mimeType: resized.mimeType,
                  hints,
                };
              }
            } catch (err) {
              console.warn(`[worker] resizeImage failed for ${att.id}: ${(err as Error).message}`);
              augmentedText += `\n<file path="${absPath}">[image processing failed]</file>`;
              continue;
            }
            if (!processed.ok) {
              augmentedText += `\n<file path="${absPath}">${processed.message}</file>`;
              continue;
            }
            const ext = extForMimeType(processed.mimeType);
            const hintLines = processed.hints.length ? processed.hints : [];
            augmentedText += `\n<file path="${absPath}">${hintLines.join('\n')}</file>`;
            images.push({ type: 'image', mimeType: processed.mimeType, data: processed.data });
          } else {
            // ── Non-image path: <file> tag with metadata ──
            try {
              readAttachmentBytes(currentHandle ?? '', att.filename, att.sha, att.mimeType);
              const displayName = att.originalFilename || att.id;
              augmentedText += `\n<file path="${absPath}" name="${displayName}" type="${att.mimeType}"></file>`;
            } catch (err) {
              console.warn(`[worker] skip non-image ${att.id}: ${(err as Error).message}`);
              augmentedText += `\n<file path="${absPath}">[attachment load failed: ${(err as Error).message}]</file>`;
            }
          }
        }
        await currentSession.prompt(augmentedText, {
          streamingBehavior: promptOptions.streamingBehavior,
          images,
        } as any);
        respond(req.id, true, null);
        return;
      }
      case 'abort': {
        if (!currentSession) throw new Error('no active session');
        await currentSession.abort();
        respond(req.id, true, null);
        return;
      }
      case 'setModel': {
        if (!currentSession) throw new Error('no active session');
        const [provider, modelId] = args as [string, string];
        await currentSession.setModel(provider, modelId);
        respond(req.id, true, null);
        return;
      }
      case 'setThinkingLevel': {
        if (!currentSession) throw new Error('no active session');
        const [level] = args as [string];
        await currentSession.setThinkingLevel(level);
        respond(req.id, true, null);
        return;
      }
      case 'setTools': {
        if (!currentSession) throw new Error('no active session');
        const [tools] = args as [string[]];
        await currentSession.setTools(tools);
        respond(req.id, true, null);
        return;
      }
      case 'listCommands': {
        if (!currentSession) throw new Error('no active session');
        const commands = await currentSession.listCommands();
        respond(req.id, true, commands);
        return;
      }
      case 'dispatchCommand': {
        if (!currentSession) throw new Error('no active session');
        const [cmdName, cmdArgs] = args as [string, string];
        await currentSession.dispatchCommand(cmdName, cmdArgs);
        respond(req.id, true, null);
        return;
      }
      case 'listAvailableModels': {
        const models = currentSession ? await currentSession.listAvailableModels() : [];
        respond(req.id, true, models);
        return;
      }
      case 'compact': {
        if (!currentSession) throw new Error('no active session');
        await currentSession.compact();
        respond(req.id, true, null);
        return;
      }
      case 'getContextUsage': {
        if (!currentSession) throw new Error('no active session');
        const usage = await currentSession.getContextUsage();
        respond(req.id, true, usage);
        return;
      }
      case 'getSystemPrompt': {
        if (!currentSession) throw new Error('no active session');
        const sp = currentSession.getSystemPrompt();
        respond(req.id, true, sp);
        return;
      }
      default:
        throw new Error(`unknown method: ${method satisfies string}`);
    }
  } catch (err) {
    // Detailed diagnostic for IPC errors — the master side strips the stack
    // when reporting, so we log the full trace here while we still have it.
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(`[worker] dispatch error method=${method} message=${msg}`);
    if (stack) console.error(stack);
    respond(req.id, false, err);
  }
}

// ---------- wire up ----------
process.on('message', (msg: unknown) => {
  if (
    msg &&
    typeof msg === 'object' &&
    'kind' in msg &&
    (msg as { kind: unknown }).kind === 'call'
  ) {
    void dispatch(msg as CallRequest);
  }
});

// Announce readiness (master checks within 200ms)
emit({ event: 'ready' as const });

// Surface unhandled errors so master sees them in stderr
process.on('uncaughtException', (err) => {
  process.stderr.write(`[worker] uncaught: ${err.stack ?? err.message}\n`);
});

// Keep process alive — wait for master's disconnect signal
process.on('disconnect', () => {
  process.exit(0);
});

// Periodic keep-alive (also flushes buffers)
setInterval(() => {}, 60_000);

// ---------- attachment helpers ----------
// Resolve an attachment id+ sha to bytes inside PI_AGENT_ATTACHMENTS_ROOT/<sessionId>/
// with realpath sandbox check and sha256 secondary verification.
const ATTACHMENTS_ROOT = process.env.PI_AGENT_ATTACHMENTS_ROOT;
if (!ATTACHMENTS_ROOT) {
  console.error('[worker] FATAL: PI_AGENT_ATTACHMENTS_ROOT env not set; worker cannot start');
  process.exit(2);
}

function extForMimeType(mime: string): string {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    default: return 'bin';
  }
}

/** Check if a mimeType is a supported image type (goes through resizeImage pipeline). */
function isImageMimeType(mime: string): boolean {
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/gif' || mime === 'image/webp';
}

/** Construct the absolute path for an attachment on disk. */
function attachmentAbsPath(sessionId: string, sha: string, mimeType: string): string {
  const ext = extForMimeType(mimeType);
  return path.join(ATTACHMENTS_ROOT!, sessionId, `${sha}.${ext}`);
}

function readAttachmentBytes(sessionId: string, filename: string, sha: string, mimeType: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('sha format invalid');
  const rootReal = realpathSync(ATTACHMENTS_ROOT!);
  const candidate = path.join(rootReal, sessionId, filename);
  // Path sandbox: ensure candidate is inside root. realpathSync requires the
  // file to exist; if it doesn't, the next line throws ENOENT.
  let realPath: string;
  try {
    realPath = realpathSync(candidate);
  } catch {
    realPath = candidate; // for ENOENT, rely on readFile error
  }
  if (!realPath.startsWith(rootReal + path.sep) && realPath !== candidate) {
    throw new Error(`path_escape: ${candidate} → ${realPath}`);
  }
  const bytes = readFileSync(realPath);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha) throw new Error(`sha_mismatch: declared=${sha} actual=${actual}`);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}