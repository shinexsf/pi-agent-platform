/**
 * Tool enable list shared by the global settings page, the agent editor and the session
 * detail view (`AgentConfig.builtinTools`).
 *
 * One list governs two things on the worker side:
 * 1. plain pi builtin tools (read / write / edit / bash / grep / find / ls / powershell)
 * 2. pi builtin EXTENSION tools (codemode / tool_search / mcp) — naming one of these in the
 *    list makes the worker load `builtin:<ext>` (see workers/session-worker/src/builtin-extensions.ts)
 *
 * `mcp` is intentionally NOT part of the "全选" default in the global settings page: loading it
 * connects every server in mcp.json on session start. It stays selectable per agent.
 *
 * Dependency rule: an mcp server hands its tools to the model according to its `exposure` in
 * mcp.json — `codemode` (the default) needs the codemode tool, `deferred` needs tool_search.
 * The platform cannot know a project's exposures before connecting, so selecting `mcp` implies
 * BOTH. The worker enforces this too (builtin-extensions.ts), so the API cannot produce a
 * half-working list. codemode / tool_search stay independently selectable without mcp.
 */

export interface BuiltinToolOption {
  value: string;
  label: string;
  /** Extra explanation rendered under the option (extension tools carry side effects). */
  hint?: string;
  /** true = pi builtin EXTENSION tool (injects `builtin:<ext>`), false = plain pi tool */
  extension?: boolean;
  /** Tools this option needs at runtime (selecting it enables them too). */
  implies?: readonly string[];
}

export const BUILTIN_TOOLS: readonly BuiltinToolOption[] = [
  { value: 'read', label: 'read (读文件)' },
  { value: 'write', label: 'write (写文件)' },
  { value: 'edit', label: 'edit (编辑文件)' },
  { value: 'bash', label: 'bash (执行命令)' },
  { value: 'grep', label: 'grep (搜索内容)' },
  { value: 'find', label: 'find (查找文件)' },
  { value: 'ls', label: 'ls (列出目录)' },
  {
    value: 'powershell',
    label: 'powershell (PowerShell 命令)',
    hint: '仅 Windows 宿主可用（非 Windows 上调用会报错）',
  },
  {
    value: 'codemode',
    label: 'codemode (脚本编排工具调用)',
    hint: '装载 pi 内置 codemode 扩展：模型写一段脚本在一次调用里串联多个工具，中间结果不进上下文。沙箱内可调用所有已启用工具（属高信任能力）。不需要 mcp 也可以单独启用',
    extension: true,
  },
  {
    value: 'tool_search',
    label: 'tool_search (按需检索工具)',
    hint: '装载 pi 内置 tool-search 扩展：检索未对模型声明的工具（codemode / deferred 形态，例如 mcp 工具）并按需加载为直接声明，下次调用即可用。纯内置工具（全部 direct）没有可搜目标，用不上',
    extension: true,
  },
  {
    value: 'mcp',
    label: 'mcp (MCP 服务器工具)',
    hint: '装载 pi 内置 mcp 扩展：会话启动即连接 mcp.json 里的全部 server。server 工具怎么交给模型由 mcp.json 的 exposure 决定（默认 codemode 需要 codemode 工具，deferred 需要 tool_search），所以勾选 mcp 会自动启用这两个工具',
    extension: true,
    implies: ['codemode', 'tool_search'],
  },
];

/** Tool names implied by selecting `mcp` (kept in sync with the `implies` field above). */
export const MCP_IMPLIED_TOOLS: readonly string[] =
  BUILTIN_TOOLS.find((tool) => tool.value === 'mcp')?.implies ?? [];

/** Which option pulled a tool in (for the "mcp 依赖" badge); undefined when it was chosen directly. */
export function impliedBy(selected: readonly string[] | null | undefined, name: string): string | undefined {
  if (!selected || !selected.includes(name)) return undefined;
  return BUILTIN_TOOLS.find((tool) => tool.implies?.includes(name) && selected.includes(tool.value))?.value;
}

/**
 * Add the tools implied by `selected` (mcp → codemode + tool_search) and return the new list.
 * Mirrors the worker-side rule in builtin-extensions.ts so the UI never shows a config the
 * runtime would silently expand.
 */
export function withImpliedTools(selected: readonly string[]): string[] {
  const next = [...selected];
  for (const tool of BUILTIN_TOOLS) {
    if (!tool.implies || !next.includes(tool.value)) continue;
    for (const implied of tool.implies) {
      if (!next.includes(implied)) next.push(implied);
    }
  }
  return next;
}

/** Values only — for `<input type="checkbox" v-model>` loops and "select all" buttons. */
export const BUILTIN_TOOL_NAMES: readonly string[] = BUILTIN_TOOLS.map((tool) => tool.value);

/**
 * The platform's default set (matches server `DEFAULT_BUILTIN_TOOLS`): everything except `mcp`.
 * Used by "全选" so one click does not silently start connecting every mcp.json server.
 */
export const BUILTIN_TOOL_DEFAULT_NAMES: readonly string[] = BUILTIN_TOOLS
  .filter((tool) => tool.value !== 'mcp')
  .map((tool) => tool.value);

/** Server-side custom tools (AgentConfig.serverBuiltinTools) — separate axis from pi tools. */
export const SERVER_BUILTIN_TOOLS = ['sendFileToUser', 'callServer'];
