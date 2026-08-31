/**
 * Print startup banner with key configuration.
 */
import { config } from './config.js';

export function printStartupBanner(): void {
  const lines = [
    `[server] pi-agent-server starting`,
    `[server] mode=${config.nodeEnv}`,
    `[server] port=${config.port}`,
    `[server] placeholder timeout=${config.placeholderTimeoutMs / 60_000} minutes`,
    `[server] max workers=${config.maxWorkers}`,
    `[server] database=${config.databasePath}`,
    `[server] workspace root=${config.workspaceRoot}`,
    `[server] agent dir=${config.agentDir}`,
    `[server] worker startup timeout=${config.workerStartupTimeoutMs}ms`,
    `[server] worker stop timeout=${config.workerStopTimeoutMs}ms`,
  ];
  for (const line of lines) {
    console.log(line);
  }
}