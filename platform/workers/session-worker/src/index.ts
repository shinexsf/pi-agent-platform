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
  ReverseCallRequest,
  ReverseCallResponse,
  WorkerEvent,
  WorkerMethod,
} from '@pi-agent-platform/ipc-protocol';
import type { RuntimeConfig } from '@pi-agent-platform/shared-types';
import { logger } from './logger.js';
// pi-coding-agent's `processImage` is not exposed via the package's main export
// map, but its two building blocks (resizeImage + formatDimensionNote) ARE.
// Server only uploads PNG/JPEG/GIF/WebP (mimeType validation), so we skip
// the format-conversion step (which would need `convertImageBytesToPng`,
// also not exported). The worker-side pipeline below mirrors pi SDK's
// processImage for the supported mime whitelist — see
// `processImage` in @earendil-works/pi-coding-agent/dist/utils/image-process.ts.
import { resizeImage, formatDimensionNote } from '@earendil-works/pi-coding-agent';
import { createSession, PiSessionAdapter } from './session.js';
import { coreMethodName } from '@pi-agent-platform/ipc-protocol';
import type { CallMasterFn } from './tools.js';
import { forwardRegistry } from './methods.js';

// State
let currentSession: PiSessionAdapter | null = null;
let currentHandle: string | null = null;

// ── Reverse IPC: Worker → Master ──────────────────────────────────────────
const reversePending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let reverseCallId = 0;

/** Reverse-call timeout. Larger than the forward side's needs because a reverse call
 *  can upload a file through an IM channel (`im.sendFile`); 30s used to time out. */
const REVERSE_CALL_TIMEOUT_MS = 60_000;

const callMaster: CallMasterFn = (method: string, args: unknown[], source = 'inline'): Promise<unknown> => {
  const id = ++reverseCallId;
  return new Promise((resolve, reject) => {
    reversePending.set(id, { resolve, reject });
    // `source` 由调用方的桥注入（插件 id / `inline`），插件代码拿不到这个字段。
    const req: ReverseCallRequest = { kind: 'reverse-call', id, method, args, source };
    process.send!(req);
    setTimeout(() => {
      if (reversePending.has(id)) {
        reversePending.delete(id);
        reject(new Error(`reverse call timeout after ${REVERSE_CALL_TIMEOUT_MS}ms: ${method}`));
      }
    }, REVERSE_CALL_TIMEOUT_MS);
  });
};
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

// ---------- forward method handlers ----------
//
// Each entry is one method's implementation. `dispatch()` never `switch`es on the
// method name — it looks it up in `forwardRegistry` (design D2: the registry is the
// sole dispatch authority, so adding a method never means editing a control-flow
// ladder, and "method exists but is disabled" becomes expressible).
//
// Handlers RETURN their result; framing (respond + error normalization) is dispatch's job.

const forwardHandlers: Record<WorkerMethod, (args: unknown[]) => Promise<unknown>> = {
  createSession: async (args) => {
    const [payload] = args as [RuntimeConfig];
    // `enabledPlugins` makes the snapshot invariant observable: the list must come from
    // the session row's config, not from the agent's current `extensions`.
    logger.info(
      {
        sessionId: payload.sessionId,
        plugins: payload.plugins?.length ?? 0,
        enabledPlugins: (payload.plugins ?? []).filter((p) => p.enabled).map((p) => p.id),
      },
      'received createSession',
    );
    const { session, handle } = await createSession(payload, emit, callMaster);
    const sessionId = payload.sessionId;
    currentSession = session;
    currentHandle = handle.id;
    logger.info(
      {
        sessionId,
        handle: handle.id,
        piSessionPath: handle.piSessionPath,
        model: handle.model ? `${handle.model.provider}/${handle.model.modelId}` : '(default)',
      },
      'session ready',
    );
    return {
      sessionHandle: handle.id,
      piSessionPath: handle.piSessionPath,
      model: handle.model,
      thinkingLevel: handle.thinkingLevel,
      sessionName: handle.sessionName,
      // leaf 只在内存里（pi 不落盘）：master 拿到后仅用于响应，不缓存。
      leafId: session.getLeafId(),
    };
  },

  prompt: async (args) => {
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
      return null;
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
          logger.warn({ err, attachmentId: att.id }, 'skip image');
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
          logger.warn({ err, attachmentId: att.id }, 'resizeImage failed');
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
          logger.warn({ err, attachmentId: att.id }, 'skip non-image');
          augmentedText += `\n<file path="${absPath}">[attachment load failed: ${(err as Error).message}]</file>`;
        }
      }
    }
    await currentSession.prompt(augmentedText, {
      streamingBehavior: promptOptions.streamingBehavior,
      images,
    } as any);
    return null;
  },

  abort: async () => {
    if (!currentSession) throw new Error('no active session');
    await currentSession.abort();
    return null;
  },

  setModel: async (args) => {
    if (!currentSession) throw new Error('no active session');
    const [provider, modelId] = args as [string, string];
    await currentSession.setModel(provider, modelId);
    return null;
  },

  setThinkingLevel: async (args) => {
    if (!currentSession) throw new Error('no active session');
    const [level] = args as [string];
    await currentSession.setThinkingLevel(level);
    return null;
  },

  setTools: async (args) => {
    if (!currentSession) throw new Error('no active session');
    const [tools] = args as [string[]];
    await currentSession.setTools(tools);
    return null;
  },

  setSessionName: async (args) => {
    if (!currentSession) throw new Error('no active session');
    const [name] = args as [string];
    currentSession.setSessionName(name);
    return null;
  },

  listCommands: async () => {
    if (!currentSession) throw new Error('no active session');
    return currentSession.listCommands();
  },

  dispatchCommand: async (args) => {
    if (!currentSession) throw new Error('no active session');
    const [cmdName, cmdArgs] = args as [string, string];
    await currentSession.dispatchCommand(cmdName, cmdArgs);
    return null;
  },

  listAvailableModels: async () =>
    currentSession ? await currentSession.listAvailableModels() : [],

  compact: async () => {
    if (!currentSession) throw new Error('no active session');
    await currentSession.compact();
    return null;
  },

  getContextUsage: async () => {
    if (!currentSession) throw new Error('no active session');
    return currentSession.getContextUsage();
  },

  getSystemPrompt: async () => {
    if (!currentSession) throw new Error('no active session');
    return currentSession.getSystemPrompt();
  },

  getSessionResources: async () => {
    if (!currentSession) throw new Error('no active session');
    return currentSession.getSessionResources();
  },

  // ── 会话树（change: session-tree-and-fork）──
  // leaf 只在 pi 的 SessionManager 里；master 不缓存，需要时来问。
  getLeafId: async () => {
    if (!currentSession) throw new Error('no active session');
    return { leafId: currentSession.getLeafId() };
  },

  getSessionTree: async () => {
    if (!currentSession) throw new Error('no active session');
    return currentSession.getSessionTree();
  },

  navigateSessionTree: async (args) => {
    if (!currentSession) throw new Error('no active session');
    const [entryId] = args as [string];
    return currentSession.navigateSessionTree(entryId);
  },
};

/** `mirror` = 1:1 pi AgentSession method; `platform` = our own lifecycle method. */
const PLATFORM_METHODS: readonly WorkerMethod[] = ['createSession'];

/** Human-facing labels for diagnostics (`/api/runtime/methods`, `ready` summary). */
const FORWARD_METHOD_DESCRIPTIONS: Partial<Record<WorkerMethod, string>> = {
  createSession: '平台生命周期：创建 / 恢复 pi 会话（三个配置段：会话行、平台注入、派生）',
  prompt: '发送一条用户消息（可带附件），pi-native',
  abort: '中断当前运行，pi-native',
  setModel: '切换 model，pi-native',
  setThinkingLevel: '切换 thinking level，pi-native',
  setTools: '覆盖启用的工具集合，pi-native',
  setSessionName: '设置 pi 原生会话显示名，pi-native',
  listCommands: '列出可用斜杠命令，pi-native',
  dispatchCommand: '执行一个斜杠命令，pi-native',
  listAvailableModels: '列出可用 model，pi-native',
  compact: '压缩上下文，pi-native',
  getContextUsage: '读取上下文用量，pi-native',
  getSystemPrompt: '读取系统提示词，pi-native',
  getSessionResources: '读取会话资源清单，pi-native',
  getLeafId: '读取当前分支末端（pi 的 leaf，只在内存里），pi-native',
  getSessionTree: '读取整棵会话树（含被放弃的分支）+ 当前 leaf，pi-native',
  navigateSessionTree: '在当前会话文件内移动 leaf（= pi 的 /tree），会刷新模型上下文与工具集',
};

/** Worker-side forward registry is shared with the plugin layer (see methods.ts). */
for (const name of Object.keys(forwardHandlers) as WorkerMethod[]) {
  forwardRegistry.register(
    coreMethodName(name),
    {
      direction: 'forward',
      source: 'core',
      kind: PLATFORM_METHODS.includes(name) ? 'platform' : 'mirror',
      description: FORWARD_METHOD_DESCRIPTIONS[name],
    },
    (args) => forwardHandlers[name](args),
  );
}
const rejectedForwardMethods = forwardRegistry.rejected();
if (rejectedForwardMethods.length > 0) {
  logger.error({ rejected: rejectedForwardMethods }, 'forward method registration rejected');
}

// ---------- dispatch ----------
async function dispatch(req: CallRequest): Promise<void> {
  const resolved = forwardRegistry.resolve(req.method);
  if (!resolved.ok) {
    // Not registered / disabled: still a well-formed response — the caller gets a
    // message it can show verbatim (`unknown method: x` vs `method disabled: x`).
    logger.warn({ method: req.method }, 'forward dispatch rejected');
    respond(req.id, false, new Error(resolved.error));
    return;
  }

  try {
    if (resolved.entry.status === 'deprecated') {
      logger.warn({ method: req.method, source: resolved.entry.source }, 'deprecated method called');
    }
    const result = await resolved.handler(req.args);
    respond(req.id, true, result ?? null);
  } catch (err) {
    // Detailed diagnostic for IPC errors — the master side strips the stack
    // when reporting, so we log the full trace here while we still have it.
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error({ method: req.method, errMsg: msg, stack }, 'dispatch error');
    respond(req.id, false, err);
  }
}

// ---------- wire up ----------
process.on('message', (msg: unknown) => {
  if (
    msg &&
    typeof msg === 'object' &&
    'kind' in msg
  ) {
    const m = msg as { kind: unknown };
    if (m.kind === 'call') {
      void dispatch(msg as CallRequest);
    } else if (m.kind === 'reverse-response') {
      const res = msg as ReverseCallResponse;
      const pending = reversePending.get(res.id);
      if (pending) {
        reversePending.delete(res.id);
        if (res.ok) {
          pending.resolve(res.result);
        } else {
          pending.reject(new Error(res.error.message));
        }
      }
    }
  }
});

// Announce readiness (master checks within 200ms) and hand over this side's method
// table. Plain data only — the registry itself never crosses the IPC boundary.
emit({
  event: 'ready' as const,
  data: {
    methods: forwardRegistry.summary(),
    rejected: forwardRegistry.rejected(),
  },
});

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
  logger.error('PI_AGENT_ATTACHMENTS_ROOT env not set; worker cannot start');
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