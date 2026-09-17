/**
 * Default tools injected into every agent session.
 *
 * Each tool is a pi SDK ToolDefinition created per-session via closures
 * that capture sessionId and callMaster. Adding new default tools only
 * requires appending to the array in createDefaultTools().
 */

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

export type CallMasterFn = (method: string, args: unknown[]) => Promise<unknown>;

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
    promptSnippet: 'sendFileToUser: Send a file or image to the user in the current chat',
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

// ── Default tools registry ──────────────────────────────────────────────────

/**
 * Create all default tools for a session.
 * New default tools are added by appending to the array here.
 */
export function createDefaultTools(
  sessionId: string,
  callMaster: CallMasterFn,
): ToolDefinition[] {
  return [
    createSendFileToUserTool(sessionId, callMaster),
    // Future default tools go here:
    // createSomeOtherTool(sessionId, callMaster),
  ];
}
