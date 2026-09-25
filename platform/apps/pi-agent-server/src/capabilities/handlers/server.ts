/**
 * server.* capabilities — process/pool status. Read-only, non-scoped.
 * MUST NOT expose credential-bearing config (models auth, tokens, DB paths).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AnyCapabilityDef, CapabilityDef } from '@pi-agent-platform/shared-types';
import type { WorkerPool } from '../../worker-pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function packageVersion(): string {
  try {
    // capabilities/handlers/ → capabilities/ → src/ → package root package.json
    // (same depth under dist/ when packaged)
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function serverCapabilities(
  workerPool: WorkerPool,
  opts: { nodeEnv: string; port: number; maxWorkers: number },
): AnyCapabilityDef[] {
  const status: CapabilityDef<undefined, unknown> = {
    method: 'server.status',
    module: 'server',
    access: 'read',
    scoped: false,
    summary: 'Server 运行状态：版本、uptime、端口、worker 池统计（不含任何凭据）',
    paramsSchema: { type: 'object', properties: {}, additionalProperties: false },
    returns:
      '{ version, uptimeMs, nodeEnv, port, pid, workers: { active, placeholders, max, pendingCalls } } — 无凭据字段',
    handler: () => {
      const list = workerPool.list();
      return {
        version: packageVersion(),
        uptimeMs: Math.round(process.uptime() * 1000),
        nodeEnv: opts.nodeEnv,
        port: opts.port,
        pid: process.pid,
        workers: {
          active: list.filter((w) => w.hasRow).length,
          placeholders: list.filter((w) => !w.hasRow).length,
          max: opts.maxWorkers,
          pendingCalls: list.reduce((n, w) => n + w.pendingCalls, 0),
        },
      };
    },
  };
  return [status];
}
