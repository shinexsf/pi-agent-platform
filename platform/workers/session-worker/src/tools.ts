/**
 * Server-side tools injected into agent sessions — tools that talk to the
 * master via reverse IPC. Gated by `AgentConfig.serverBuiltinTools`
 * (undefined/null → DEFAULT_SERVER_BUILTIN_TOOLS; [] → none; array → allowlist),
 * independent from `builtinTools` (pi builtin tools only).
 *
 * Each tool is a pi SDK ToolDefinition created per-session via closures
 * that capture sessionId and callMaster. Adding a server tool = append a
 * factory here + include its name in the default list (if default-on).
 */

import type { CapabilityIndexEntry } from '@pi-agent-platform/shared-types';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

export type CallMasterFn = (method: string, args: unknown[]) => Promise<unknown>;

/** Default when AgentConfig.serverBuiltinTools is undefined/null.
 *  callServer is power — OFF by default, opt-in per agent (spec callserver-tool). */
const DEFAULT_SERVER_BUILTIN_TOOLS = ['sendFileToUser'];

export interface ServerToolsOptions {
  /** Raw AgentConfig.serverBuiltinTools value (undefined/null → default set). */
  serverBuiltinTools?: string[];
  /** Compact capability index pushed by master at createSession — embedded into
   *  the callServer description so the model needs zero extra round-trips. */
  capabilityIndex?: CapabilityIndexEntry[];
}

// ── sendFileToUser ──────────────────────────────────────────────────────────

/**
 * Parameters for sendFileToUser tool.
 * Defined as a plain object matching TypeBox's JSON Schema output format.
 */
const sendFileToUserSchema = {
  type: 'object',
  properties: {
    filePath: { type: 'string', description: 'Absolute path to the file to send' },
    fileName: { type: 'string', description: 'Friendly display name without extension (system auto-appends the correct extension from the actual file)' },
    caption: { type: 'string', description: 'Optional text caption to send with the file' },
  },
  required: ['filePath'],
  additionalProperties: false,
} as const;

interface SendFileToUserParams {
  filePath: string;
  fileName?: string;
  caption?: string;
}

function createSendFileToUserTool(
  sessionId: string,
  callMaster: CallMasterFn,
): ToolDefinition {
  return {
    name: 'sendFileToUser',
    label: 'Send File to User',
    description: 'Send a file or image to the user in the current chat',
    promptSnippet: 'Send a file or image to the user in the current chat',
    promptGuidelines: [
      'Use sendFileToUser to share generated files, images, charts, or documents with the user.',
      'The file must exist on disk. Use write tool first if needed.',
      'fileName is a display name without extension — the system auto-appends the correct extension from the actual file.',
    ],
    parameters: sendFileToUserSchema as any,
    execute: async (
      _toolCallId: string,
      params: SendFileToUserParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) => {
      try {
        const result = await callMaster('sendFileToUser', [sessionId, params]);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          details: result,
        };
      } catch (err) {
        const errorMsg = `Failed to send file: ${(err as Error).message}`;
        return {
          content: [{ type: 'text' as const, text: errorMsg }],
          details: { error: errorMsg },
        };
      }
    },
  };
}

// ── callServer ──────────────────────────────────────────────────────────────

/**
 * Parameters for callServer — the single meta-tool dispatching to the master
 * capability control plane (reverse IPC `invokeCapability`). Per-method
 * schemas are NOT expressible here; they are self-described via the builtin
 * `list` / `detail` methods and embedded in the description below.
 */
const callServerSchema = {
  type: 'object',
  properties: {
    method: {
      type: 'string',
      description: 'Capability method name, e.g. "server.status", "agent.list", "session.update"',
    },
    params: {
      type: 'object',
      description: 'Method params — run the `detail` builtin first if unsure about the shape',
    },
  },
  required: ['method'],
  additionalProperties: false,
} as const;

interface CallServerParams {
  method: string;
  params?: Record<string, unknown>;
}

/** Build the tool description embedding the capability index (D2: zero-round-trip first use). */
function buildCallServerDescription(index: CapabilityIndexEntry[]): string {
  const lines = index.map((e) => `- ${e.method} (${e.access}${e.scoped ? ', scoped' : ''}): ${e.summary}`);
  return [
    'Call host-server management capabilities (query server status, agents, sessions; update configs).',
    '',
    'Available methods (authorized for this session):',
    ...(lines.length > 0 ? lines : ['(no authorized business methods; `list` / `detail` still work)']),
    '',
    'Builtins:',
    '- list: grouped index of your authorized methods by module (server/agent/session/channel/config)',
    '- detail: full params schema + return shape + effect timing of one method — { method: "<name>" }',
    '',
    'Unknown method errors include the available method list.',
  ].join('\n');
}

function createCallServerTool(
  callMaster: CallMasterFn,
  index: CapabilityIndexEntry[],
): ToolDefinition {
  return {
    name: 'callServer',
    label: 'Call Server Capability',
    description: buildCallServerDescription(index),
    promptSnippet:
      'Query or manage the host server (server/agent/session capabilities). `list` enumerates your authorized methods by module; `detail` explains exact params of a method.',
    promptGuidelines: [
      'Use callServer for anything about the host platform: server status, listing/updating agents or sessions.',
      'Before calling a method you have not used this session, call `detail` with { method } to get its exact params and effect timing.',
      'Write capabilities (access: write) may be denied by policy — surface the error to the user instead of retrying blindly.',
    ],
    parameters: callServerSchema as any,
    execute: async (
      _toolCallId: string,
      params: CallServerParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: unknown,
    ) => {
      try {
        const result = await callMaster('invokeCapability', [params.method, params.params]);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }],
          details: result,
        };
      } catch (err) {
        // Control-plane errors are model-readable by design (unknown method lists
        // available methods; denials state the reason) — relay verbatim.
        const errorMsg = (err as Error).message;
        return {
          content: [{ type: 'text' as const, text: `callServer error: ${errorMsg}` }],
          details: { error: errorMsg },
        };
      }
    },
  };
}

// ── Server tools registry ───────────────────────────────────────────────────

/**
 * Create the server-side tools enabled for this session.
 * Gated by AgentConfig.serverBuiltinTools (undefined/null → default set,
 * [] → none, array → exact allowlist).
 */
export function createServerTools(
  sessionId: string,
  callMaster: CallMasterFn,
  opts: ServerToolsOptions = {},
): ToolDefinition[] {
  const enabled = new Set(opts.serverBuiltinTools ?? DEFAULT_SERVER_BUILTIN_TOOLS);
  const tools: ToolDefinition[] = [];
  if (enabled.has('sendFileToUser')) {
    tools.push(createSendFileToUserTool(sessionId, callMaster));
  }
  if (enabled.has('callServer')) {
    tools.push(createCallServerTool(callMaster, opts.capabilityIndex ?? []));
  }
  return tools;
}
