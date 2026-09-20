/**
 * prompt-resolver — unified prompt resolution for both HTTP and IM paths.
 *
 * Pipeline:
 *   1. Slash command check (short-circuit with `intercepted` response)
 *   2. Attachment placeholder parsing (`[pi-attachment:att_xxx]` → lookup)
 *   3. Agent config loading (from session table, fallback to opts.agentId)
 *   4. StreamingBehavior determination
 *
 * Both `routes/sessions.ts` (HTTP) and `im-gateway/routing.ts` (IM) call
 * this function, ensuring identical behavior across channels.
 */

import path from 'node:path';
import type { SessionRepo } from './repos/session.repo.js';
import type { AgentRepo } from './repos/agent.repo.js';
import type { AttachmentStore } from './services/attachment-store.js';
import { runBuiltinCommand } from './im-gateway/slash-commands.js';
import type { SessionId } from '@pi-agent-platform/channel-types';

export interface ResolvePromptOpts {
  /** Explicit streamingBehavior from caller (HTTP: body.streamingBehavior). */
  streamingBehavior?: 'steer' | 'followUp';
  /** IM-side: default streamingBehavior to 'steer' when caller doesn't specify one. */
  allowSteer?: boolean;
  /** Fallback agentId when session row doesn't exist yet (placeholder). */
  agentId?: string;
  /** Context for slash command execution (routing layer provides helpers). */
  slashCtx?: {
    getSessionSummary: () => Promise<{
      model: string;
      thinkingLevel: string | null;
      title: string | null;
      messageCount?: number;
    }>;
    setModel?: (model: string) => Promise<void>;
    setThinkingLevel?: (level: 'off' | 'low' | 'medium' | 'high') => Promise<void>;
    compact?: () => Promise<void>;
    startNewSession: () => Promise<{ sessionId: SessionId }>;
    setTitle?: (title: string) => Promise<void>;
  };
}

export interface ResolvedPrompt {
  /** The message text (with placeholders still in place — worker resolves them). */
  message: string;
  /** Options to pass to worker's prompt IPC call. */
  promptOptions: {
    streamingBehavior?: 'steer' | 'followUp';
    attachments?: Array<{ id: string; sha: string; mimeType: string; filename: string; originalFilename: string }>;
  };
  /** If the message was a slash command, this contains the response to send back. */
  intercepted?: { kind: 'text'; content: string };
}

/** Regex for `<file attId="att_<id>">` tags in message text. */
const ATTACHMENT_MARKER_RE = /<file\s[^>]*attId="(att_[a-f0-9]{12})"[^>]*>/g;

/**
 * Resolve a prompt message: parse slash commands, resolve attachment placeholders,
 * load agent config, and determine streaming behavior.
 */
export async function resolvePrompt(
  sessionId: string,
  messageText: string,
  opts: ResolvePromptOpts,
  deps: {
    sessionRepo: SessionRepo;
    agentRepo: AgentRepo;
    attachmentStore: AttachmentStore;
  },
): Promise<ResolvedPrompt> {
  const trimmed = messageText.trim();

  // ── 1. Slash command check ────────────────────────────────────────────────
  if (trimmed.startsWith('/') && opts.slashCtx) {
    const space = trimmed.indexOf(' ');
    const cmdName = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
    const args = space === -1 ? '' : trimmed.slice(space + 1).trim();

    const reply = await runBuiltinCommand(cmdName, {
      sessionId: sessionId as SessionId,
      args,
      ctx: opts.slashCtx,
    });

    if (reply !== null) {
      return {
        message: '',
        promptOptions: {},
        intercepted: { kind: 'text', content: reply },
      };
    }
    // Not a builtin → fall through to agent prompt (text passes as-is)
  }

  // ── 2. Attachment placeholder parsing ─────────────────────────────────────
  const referencedIds = Array.from(
    new Set(
      [...messageText.matchAll(ATTACHMENT_MARKER_RE)].map((m) => m[1] as string),
    ),
  );

  let attachmentMeta: Array<{ id: string; sha: string; mimeType: string; filename: string; originalFilename: string }> | undefined;
  if (referencedIds.length > 0) {
    const found = await deps.attachmentStore.lookupForPrompt(sessionId, referencedIds);
    const foundIds = new Set(found.map((r) => r.id));
    const missing = referencedIds.filter((rid) => !foundIds.has(rid));
    if (missing.length > 0) {
      // Unknown attachment ids — degrade gracefully (strip markers, continue)
      // or could throw; for robustness, strip and log.
      console.warn(`[prompt-resolver] unknown attachment ids: ${missing.join(', ')}`);
    }
    if (found.length > 0) {
      attachmentMeta = found.map((r) => ({
        id: r.id,
        sha: r.sha,
        mimeType: r.mimeType,
        filename: path.basename(r.path),
        originalFilename: r.originalFilename,
      }));
    }
  }

  // ── 3. Agent config loading ───────────────────────────────────────────────
  // Loaded for potential use by caller (e.g. building RuntimeConfig).
  // The prompt-resolver doesn't directly use agent config, but ensures the
  // session → agent linkage is valid.
  const session = deps.sessionRepo.get(sessionId);
  const agentId = session?.agentId ?? opts.agentId;
  if (agentId) {
    const agent = deps.agentRepo.get(agentId);
    if (!agent) {
      console.warn(`[prompt-resolver] agent ${agentId} not found for session ${sessionId}`);
    }
  }

  // ── 4. StreamingBehavior determination ────────────────────────────────────
  let streamingBehavior = opts.streamingBehavior;
  if (!streamingBehavior && opts.allowSteer) {
    // IM-side: always default to 'steer'.
    // When agent is idle, pi SDK ignores streamingBehavior (normal prompt).
    // When agent is busy, steer interrupts current generation.
    streamingBehavior = 'steer';
  }

  return {
    message: messageText,
    promptOptions: {
      streamingBehavior,
      attachments: attachmentMeta,
    },
  };
}
