/**
 * Per-session MCP server resolution from the platform catalog (change: platform-mcp-catalog).
 *
 * The catalog (`~/.pi/server/mcp.json`, path injected as `PI_SERVER_MCP_CONFIG`) is maintained
 * once for the whole platform. Each agent only selects NAMES (`AgentConfig.mcp.servers`), so
 * this module turns that selection into the definitions the session registers with
 * `pi.registerMcpServer()`.
 *
 * Nothing is written anywhere: pi's own `mcp.json` files stay untouched, and definitions never
 * enter the platform DB. pi gives a same-named server from its own `mcp.json` precedence over an
 * extension registration, so those names are reported as conflicts (the UI warns about them).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseMcpCatalog } from '@pi-agent-platform/shared-types';
import { logger } from './logger.js';

const log = logger.child({ module: 'mcp-catalog' });

/** One server definition handed to `pi.registerMcpServer(name, config)`. */
export interface SelectedMcpServer {
  name: string;
  config: Record<string, unknown>;
}

export interface McpSelectionResult {
  /** Servers to register (catalog entries that are selected, valid and enabled). */
  servers: SelectedMcpServer[];
  /** Selected names that could not be resolved, plus catalog parse errors. */
  errors: string[];
  /** Names pi's own mcp.json also defines — pi wins those, so the platform switch is moot. */
  conflicts: string[];
  catalogPath: string;
}

/** `PI_SERVER_MCP_CONFIG`, else `<agentDir>/../server/mcp.json` (`~/.pi/server/mcp.json`). */
export function resolveCatalogPath(agentDir: string): string {
  return process.env.PI_SERVER_MCP_CONFIG ?? join(dirname(agentDir), 'server', 'mcp.json');
}

/** Server names defined by a pi mcp.json file (missing/broken file → no names). */
function readPiMcpServerNames(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { mcpServers?: unknown };
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object') return [];
    return Object.keys(servers as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * Resolve an agent's MCP selection against the platform catalog.
 *
 * Missing catalog = no servers (a fresh install has nothing configured). Every failure is
 * non-fatal: the session still starts with whatever resolved.
 */
export function loadSelectedMcpServers(options: {
  agentDir: string;
  /** Session working directory — a project `.pi/mcp.json` here also shadows the catalog. */
  cwd: string;
  selections?: readonly string[] | null;
}): McpSelectionResult {
  const catalogPath = resolveCatalogPath(options.agentDir);
  const selections = options.selections ?? [];
  const result: McpSelectionResult = { servers: [], errors: [], conflicts: [], catalogPath };

  if (!existsSync(catalogPath)) {
    if (selections.length > 0) {
      result.errors.push(`catalog ${catalogPath} not found; ${selections.length} selected server(s) skipped`);
    }
    return result;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(catalogPath, 'utf-8'));
  } catch (err) {
    result.errors.push(`${catalogPath}: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  const parsed = parseMcpCatalog(raw);
  result.errors.push(...parsed.errors);
  const byName = new Map(parsed.servers.map((server) => [server.name, server]));

  for (const name of selections) {
    const entry = byName.get(name);
    if (!entry) {
      result.errors.push(`server "${name}" is not in the catalog`);
      continue;
    }
    if (!entry.enabled) {
      log.info({ server: name }, 'mcp server disabled in catalog; skipped');
      continue;
    }
    result.servers.push({ name: entry.name, config: entry.config });
  }

  // pi loads ~/.pi/agent/mcp.json and the project's .pi/mcp.json itself; a same-named server
  // there wins over the registration, so "off" in the platform would not actually turn it off.
  const piNames = new Set([
    ...readPiMcpServerNames(join(options.agentDir, 'mcp.json')),
    ...readPiMcpServerNames(join(options.cwd, '.pi', 'mcp.json')),
  ]);
  result.conflicts = result.servers.filter((server) => piNames.has(server.name)).map((s) => s.name);

  if (result.conflicts.length > 0) {
    log.warn(
      { conflicts: result.conflicts, catalogPath },
      'mcp.json also defines these servers; pi wins those definitions',
    );
  }
  if (result.errors.length > 0) {
    log.warn({ errors: result.errors, catalogPath }, 'mcp catalog entries could not be resolved');
  }
  return result;
}
