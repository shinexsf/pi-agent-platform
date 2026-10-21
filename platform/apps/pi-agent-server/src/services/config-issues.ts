/**
 * Shared "which saved config values no longer resolve" helper (change: explicit-agent-config).
 *
 * Deliberately checks only lists this process knows authoritatively (platform tool names +
 * the in-memory capability registry). Environment-scanned resources (extensions / skills /
 * prompts / models) are validated live by the web UI, so a save never reports a false
 * positive merely because the server could not see a directory.
 */

import {
  findConfigIssues,
  type AgentConfig,
  type ConfigIssue,
} from '@pi-agent-platform/shared-types';
import { listCapabilities } from '../capabilities/registry.js';

export function collectConfigIssues(config?: AgentConfig | null): ConfigIssue[] {
  return findConfigIssues(config, {
    capabilities: listCapabilities().map((d) => d.method),
  });
}
