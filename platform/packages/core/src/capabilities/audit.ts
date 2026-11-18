/**
 * Capability audit — one structured pino line per dispatch attempt.
 * Both successful calls AND denials/unknown methods are logged (attempted
 * abuse must leave a trail). Diagnostic detail stays in the params digest;
 * level: info for ok, warn for denied, error for handler failure.
 */

import { childLogger } from '../logger.js';

const logger = childLogger('capability');

export interface AuditFields {
  sessionId: string;
  agentId?: string;
  method: string;
  params: unknown;
  status: 'ok' | 'denied' | 'unknown' | 'error';
  durationMs: number;
  errorMessage?: string;
}

/** Cap the params digest so a huge payload can't flood the log line. */
function digest(params: unknown): string {
  if (params === undefined) return '';
  try {
    const s = JSON.stringify(params);
    return s.length > 500 ? `${s.slice(0, 500)}…(${s.length})` : s;
  } catch {
    return '[unserializable]';
  }
}

export function auditCapability(fields: AuditFields): void {
  const line = {
    sessionId: fields.sessionId,
    agentId: fields.agentId,
    method: fields.method,
    params: digest(fields.params),
    status: fields.status,
    durationMs: fields.durationMs,
    ...(fields.errorMessage ? { errMsg: fields.errorMessage } : {}),
  };
  if (fields.status === 'ok') logger.info(line, 'capability invoke');
  else if (fields.status === 'denied' || fields.status === 'unknown') logger.warn(line, 'capability invoke');
  else logger.error(line, 'capability invoke');
}
