/**
 * Platform MCP catalog reader (change: platform-mcp-catalog).
 *
 * Server definitions are maintained once, by hand, in `~/.pi/server/mcp.json` — the same shape
 * pi's `mcp.json` uses, so an existing pi file can be copied over unchanged. The platform never
 * writes it and never copies definitions into the DB: agents only select server NAMES, and the
 * worker registers the matching definitions with `pi.registerMcpServer()` for that session.
 *
 * Conflict detection: pi still loads `~/.pi/agent/mcp.json` (and a trusted project's
 * `.pi/mcp.json`) itself. A server defined there wins over the platform registration, so a
 * "turned off in the platform" server would still connect. We surface those names instead of
 * letting the switch silently do nothing.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  parseMcpCatalog,
  type McpCatalogEntry,
  type ParsedMcpCatalog,
} from '@pi-agent-platform/shared-types';
import type { McpCatalogResponseDTO } from '@pi-agent-platform/api-types';

export interface McpCatalogReadResult extends ParsedMcpCatalog {
  path: string;
  conflicts: string[];
}

/** Read pi's own global `mcp.json` server names (`~/.pi/agent/mcp.json`). */
export function readPiMcpServerNames(agentDir: string): string[] {
  const file = path.join(agentDir, 'mcp.json');
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return [];
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (!servers || typeof servers !== 'object') return [];
    return Object.keys(servers as Record<string, unknown>);
  } catch {
    // A broken pi mcp.json is pi's problem to report; the catalog stays usable.
    return [];
  }
}

/**
 * Read + validate the platform catalog.
 *
 * Missing file = empty catalog (not an error): a fresh install has nothing configured yet.
 */
export function readMcpCatalog(options: { mcpConfigPath: string; agentDir: string }): McpCatalogReadResult {
  const { mcpConfigPath, agentDir } = options;
  if (!existsSync(mcpConfigPath)) {
    return { path: mcpConfigPath, servers: [], errors: [], conflicts: [] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
  } catch (err) {
    return {
      path: mcpConfigPath,
      servers: [],
      errors: [`${mcpConfigPath}: ${err instanceof Error ? err.message : String(err)}`],
      conflicts: [],
    };
  }

  const parsed = parseMcpCatalog(raw);
  // pi's own mcp.json wins same-named servers, so list the overlap.
  const piNames = new Set(readPiMcpServerNames(agentDir));
  const conflicts = parsed.servers.filter((s) => piNames.has(s.name)).map((s) => s.name);
  return { path: mcpConfigPath, ...parsed, conflicts };
}

/** Catalog server names — the availability list used to flag stale `mcp.servers` entries. */
export function listMcpServerNames(result: McpCatalogReadResult): string[] {
  return result.servers.map((server) => server.name);
}

/** API DTO shape (`GET /api/config/mcp-servers`). */
export function toMcpCatalogResponse(result: McpCatalogReadResult): McpCatalogResponseDTO {
  return {
    path: result.path,
    servers: result.servers.map((server: McpCatalogEntry) => ({
      name: server.name,
      config: server.config,
      exposure: server.exposure,
      description: server.description,
    })),
    errors: result.errors,
    conflicts: result.conflicts,
  };
}

// ---------- Maintenance (change: platform-mcp-catalog, management UI) ----------

/**
 * The catalog used to be hand-edited only; the config page now writes it. Writes preserve
 * everything the platform does not model: unknown top-level keys (e.g. `autoEnableCodemode`)
 * and unknown per-server fields (`timeout`, `headers`, …), because the file is pi-shaped and
 * pi consumes those fields directly.
 */
export class McpCatalogError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = 'McpCatalogError';
  }
}

/** pi's server names become tool namespaces (`mcp__<name>__<tool>` after `-`→`_`). */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function readRawCatalog(mcpConfigPath: string): Record<string, unknown> {
  if (!existsSync(mcpConfigPath)) return { mcpServers: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
  } catch (err) {
    throw new McpCatalogError(
      `${mcpConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
      400,
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new McpCatalogError(`${mcpConfigPath}: expected a JSON object`, 400);
  }
  return raw as Record<string, unknown>;
}

function writeRawCatalog(mcpConfigPath: string, data: Record<string, unknown>): void {
  mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
  // Write-then-rename: a crashed write must not leave a half-valid catalog behind.
  const tmp = `${mcpConfigPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  renameSync(tmp, mcpConfigPath);
}

function serverMap(raw: Record<string, unknown>): Record<string, unknown> {
  const existing = raw.mcpServers;
  if (existing === undefined) return {};
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    throw new McpCatalogError('"mcpServers" must be an object', 400);
  }
  return existing as Record<string, unknown>;
}

/** Validate one entry with the same parser the read path uses, so both sides agree. */
function assertValidEntry(name: string, config: unknown): void {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new McpCatalogError(
      `invalid server name ${JSON.stringify(name)}: use letters, digits, "_", "." or "-"`,
      400,
    );
  }
  const parsed = parseMcpCatalog({ mcpServers: { [name]: config } });
  if (parsed.errors.length > 0) throw new McpCatalogError(parsed.errors.join('; '), 400);
}

export interface McpServerWriteInput {
  /** New name — rename supported. Defaults to the current name. */
  name?: string;
  config: Record<string, unknown>;
}

/** Add a server. 409 when the name is taken. */
export function createMcpServer(
  options: { mcpConfigPath: string; name: string; config: Record<string, unknown> },
): void {
  const { mcpConfigPath, name, config } = options;
  const raw = readRawCatalog(mcpConfigPath);
  const servers = serverMap(raw);
  if (Object.prototype.hasOwnProperty.call(servers, name)) {
    throw new McpCatalogError(`server "${name}" already exists`, 409);
  }
  assertValidEntry(name, config);
  servers[name] = config;
  raw.mcpServers = servers;
  writeRawCatalog(mcpConfigPath, raw);
}

/** Replace one server's definition (and optionally rename it). 404 when missing, 409 on rename clash. */
export function updateMcpServer(
  options: { mcpConfigPath: string; name: string; input: McpServerWriteInput },
): string {
  const { mcpConfigPath, name, input } = options;
  const raw = readRawCatalog(mcpConfigPath);
  const servers = serverMap(raw);
  if (!Object.prototype.hasOwnProperty.call(servers, name)) {
    throw new McpCatalogError(`server "${name}" not found`, 404);
  }
  const nextName = (input.name ?? name).trim() || name;
  assertValidEntry(nextName, input.config);
  if (nextName !== name) {
    if (Object.prototype.hasOwnProperty.call(servers, nextName)) {
      throw new McpCatalogError(`server "${nextName}" already exists`, 409);
    }
    // Rebuild in place so the file keeps its original ordering.
    for (const key of Object.keys(servers)) {
      if (key !== name) continue;
      servers[nextName] = input.config;
      delete servers[key];
      break;
    }
  } else {
    servers[name] = input.config;
  }
  raw.mcpServers = servers;
  writeRawCatalog(mcpConfigPath, raw);
  return nextName;
}

/** Remove a server. 404 when missing. */
export function deleteMcpServer(options: { mcpConfigPath: string; name: string }): void {
  const { mcpConfigPath, name } = options;
  const raw = readRawCatalog(mcpConfigPath);
  const servers = serverMap(raw);
  if (!Object.prototype.hasOwnProperty.call(servers, name)) {
    throw new McpCatalogError(`server "${name}" not found`, 404);
  }
  delete servers[name];
  raw.mcpServers = servers;
  writeRawCatalog(mcpConfigPath, raw);
}
