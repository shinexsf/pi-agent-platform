/**
 * MCP tool helpers — MCP is a capability, not part of the tool whitelist
 * (change: mcp-as-first-class-capability).
 *
 * pi registers MCP server tools as `mcp__<server>__<tool>` (and three resource tools without the
 * prefix). Two consequences the platform has to handle:
 * - the tool whitelist (`builtinTools`) must not deactivate them — their active state is pi's
 *   business (`exposure`), otherwise a `direct`-exposure server would silently stop declaring
 *   its tools;
 * - session-info reports them per server instead of flat in the tools list.
 *
 * Naming rules mirror pi (`dist/extensions/mcp/tools.js:46`, `dist/core/mcp-servers.js:33`):
 * everything but `[A-Za-z0-9_]` is replaced by `_`, and over-long names are truncated with an
 * 8-char hash suffix — the truncation keeps the `mcp__<server>__` prefix, so the server segment
 * stays parseable. A non-greedy match is used for the server, same as pi's own parser
 * (`dist/extensions/mcp/index.js:280`).
 */

/** Resource tools pi counts as MCP even though they carry no `mcp__` prefix. */
const MCP_RESOURCE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
]);

const MCP_TOOL_NAME_PATTERN = /^mcp__(.+?)__(.+)$/;

/** Group name for MCP tools whose name cannot be mapped back to a server. */
const UNKNOWN_SERVER = '(unknown)';

/** Whether a tool belongs to MCP (server tool or resource tool). */
export function isMcpToolName(name: string): boolean {
  return name.startsWith('mcp__') || MCP_RESOURCE_TOOL_NAMES.has(name);
}

/** Shape of the tool data we need; matches pi's `ToolInfo` subset. */
export interface McpToolLike {
  name: string;
  description: string;
  exposure?: string;
  active: boolean;
}

/** One group in the session-info MCP section. */
export interface McpServerGroup<TObject = McpToolLike> {
  /** Server name as it appears in the tool names (`-` already mapped to `_` by pi). */
  name: string;
  kind: 'server' | 'resources';
  tools: TObject[];
}

/**
 * Group MCP tools by server for display.
 *
 * Ordering: servers by tool count (desc) then name, so the biggest server leads; the
 * `resources` group always sorts last because it is not a server. Unknown names land in
 * `(unknown)` rather than being dropped.
 */
export function groupMcpTools<T extends McpToolLike>(tools: readonly T[]): McpServerGroup<T>[] {
  const servers = new Map<string, T[]>();
  const resources: T[] = [];

  for (const tool of tools) {
    if (MCP_RESOURCE_TOOL_NAMES.has(tool.name)) {
      resources.push(tool);
      continue;
    }
    const match = MCP_TOOL_NAME_PATTERN.exec(tool.name);
    const server = match?.[1] ?? UNKNOWN_SERVER;
    const bucket = servers.get(server);
    if (bucket) bucket.push(tool);
    else servers.set(server, [tool]);
  }

  const groups: McpServerGroup<T>[] = [...servers.entries()]
    .map(([name, groupTools]) => ({ name, kind: 'server' as const, tools: groupTools }))
    .sort((a, b) => b.tools.length - a.tools.length || a.name.localeCompare(b.name));

  if (resources.length > 0) {
    groups.push({ name: 'resources', kind: 'resources', tools: resources });
  }
  return groups;
}

/** Tools of a group that the model cannot see yet (`deferred` / `hidden`). */
export function countUnloaded(group: { tools: readonly { exposure?: string }[] }): number {
  return group.tools.filter((t) => t.exposure === 'deferred' || t.exposure === 'hidden').length;
}
