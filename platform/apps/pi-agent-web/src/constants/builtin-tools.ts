/**
 * Tool enable list shared by the global settings page, the agent editor and the session
 * detail view (`AgentConfig.builtinTools`).
 *
 * One list governs two things on the worker side:
 * 1. plain pi builtin tools (read / write / edit / bash / grep / find / ls / powershell)
 * 2. pi builtin EXTENSION tools (codemode / tool_search) — naming one makes the worker load
 *    `builtin:<ext>` (see workers/session-worker/src/builtin-extensions.ts)
 *
 * MCP is NOT in this list any more (change: mcp-as-first-class-capability). It is a capability
 * switch (`AgentConfig.mcp.enabled` / `defaultMcp`) rendered as its own toggle next to the list,
 * because enabling it connects every server in mcp.json on session start and registers tools
 * named `mcp__<server>__<tool>` — none of which is a tool you pick by name.
 *
 * Dependency rule: enabling MCP turns on codemode + tool_search, because a server hands its
 * tools to the model according to its `exposure` in mcp.json — `codemode` (the default) needs
 * the codemode tool, `deferred` needs tool_search, and the platform cannot know a project's
 * exposures before connecting. Turning MCP off leaves those two selections untouched.
 */

export interface BuiltinToolOption {
  value: string;
  label: string;
  /** Extra explanation rendered under the option (extension tools carry side effects). */
  hint?: string;
  /** true = pi builtin EXTENSION tool (injects `builtin:<ext>`), false = plain pi tool */
  extension?: boolean;
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
];

/** Values only — for `<input type="checkbox" v-model>` loops and "select all" buttons. */
export const BUILTIN_TOOL_NAMES: readonly string[] = BUILTIN_TOOLS.map((tool) => tool.value);

/** 新建 agent 的初始工具集（7 项跨平台基础工具）。 */
export const BASE_TOOL_NAMES: readonly string[] = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];

/**
 * 新建 agent 的初始配置（change: explicit-agent-config）。
 *
 * 平台不再有"全局默认层"：这份值只是"新表单的初始勾选"，保存后即成为该 agent 的显式清单。
 * `capabilities: null` 是唯一例外语义（null = 全局 callServer 策略）。
 */
export const BASE_AGENT_CONFIG = {
  builtinTools: [...BASE_TOOL_NAMES],
  extensions: [] as string[],
  skills: [] as string[],
  prompts: [] as string[],
  mcp: { enabled: false },
  serverBuiltinTools: ['sendFileToUser'],
  capabilities: null as string[] | null,
};

/**
 * Tools the MCP capability brings along (codemode + tool_search).
 * Mirrors the worker-side rule in builtin-extensions.ts.
 */
export const MCP_DEPENDENT_TOOLS: readonly string[] = ['codemode', 'tool_search'];

/** Text shown next to the MCP switch in all three config surfaces. */
export const MCP_SWITCH_HINT =
  '装载 pi 内置 mcp 扩展：会话启动即连接 mcp.json 里的全部 server（工具名为 mcp__<server>__<tool>）。开启后会自动勾选 codemode 与 tool_search，否则默认 exposure 下的 mcp 工具对模型不可见';

/** Add the MCP dependencies to a tool selection (idempotent). */
export function withMcpDependencies(selected: readonly string[]): string[] {
  const next = [...selected];
  for (const name of MCP_DEPENDENT_TOOLS) {
    if (!next.includes(name)) next.push(name);
  }
  return next;
}

/** Server-side custom tools (AgentConfig.serverBuiltinTools) — separate axis from pi tools. */
export const SERVER_BUILTIN_TOOLS = ['sendFileToUser', 'callServer'];
