/**
 * Server config: load from environment variables.
 *
 * Validates types and exits on invalid values.
 */

export interface ServerConfig {
  port: number;
  nodeEnv: 'development' | 'production' | 'test';
  isDev: boolean;
  /** Idle timeout for placeholder workers (no DB row). Active sessions never auto-timeout —
   *  they're killed explicitly (IDE tab close, future Web manual management). */
  placeholderTimeoutMs: number;
  /** Max concurrent worker processes. LRU-evicts placeholder workers when full. */
  maxWorkers: number;
  databasePath: string;
  workerStartupTimeoutMs: number;
  workerStopTimeoutMs: number;
  workspaceRoot: string;
  agentDir: string;
  /** Directory for user-uploaded image attachments, organized as <root>/<sessionId>/<sha>.<ext>.
   *  Read tool images (live session) are NOT stored here — they're owned by the source filesystem path. */
  attachmentsDir: string;
}

function parseIntStrict(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    console.error(`[server] invalid ${name}=${raw}, must be a positive integer`);
    process.exit(1);
  }
  if (n <= 0) {
    console.error(`[server] invalid ${name}=${raw}, must be > 0`);
    process.exit(1);
  }
  return n;
}

function parseNodeEnv(raw: string | undefined): ServerConfig['nodeEnv'] {
  if (raw === 'production' || raw === 'test') return raw;
  return 'development';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);

  return {
    port: parseIntStrict('PORT', env.PORT, 3000),
    nodeEnv,
    isDev: nodeEnv !== 'production',
    placeholderTimeoutMs: parseIntStrict(
      'PLACEHOLDER_TIMEOUT_MINUTES',
      env.PLACEHOLDER_TIMEOUT_MINUTES,
      5, // default 5 minutes for placeholder (no DB row)
    ) * 60_000,
    maxWorkers: parseIntStrict('MAX_WORKERS', env.MAX_WORKERS, 20),
    databasePath: env.DATABASE_PATH ?? './data.db',
    workerStartupTimeoutMs: parseIntStrict('WORKER_STARTUP_TIMEOUT_MS', env.WORKER_STARTUP_TIMEOUT_MS, 5000), // default 5s — pi SDK load takes ~1s (auth + models). 200ms was wishful.
    workerStopTimeoutMs: 5_000,   // invariants: SIGTERM → 5s → SIGKILL
    workspaceRoot: env.WORKSPACE_ROOT ?? process.cwd(),
    agentDir: env.PI_AGENT_DIR ?? defaultAgentDir(),
    attachmentsDir: env.PI_AGENT_ATTACHMENTS_ROOT ?? defaultAttachmentsDir(),
  };
}

function defaultAttachmentsDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.env.HOMEPATH ?? '.';
  const sep = home.includes('\\') ? '\\' : '/';
  return `${home}${sep}.pi-agent-server${sep}attachments`;
}

function defaultAgentDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.env.HOMEPATH ?? '.';
  const sep = home.includes('\\') ? '\\' : '/';
  return `${home}${sep}.pi${sep}agent`;
}

export const config = loadConfig();