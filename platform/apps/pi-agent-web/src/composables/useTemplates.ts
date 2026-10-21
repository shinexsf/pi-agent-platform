/**
 * 配置模板（agent-templates change）：三处编辑面共用的读取 / 快照 / 填充逻辑。
 *
 * 模板 = 七个 AgentConfig 字段的快照（systemPrompt 不在其中）。填充是**显式覆盖**
 * 六个资源字段 + capabilities，不动名称 / 模型 / 工作区 / systemPrompt；
 * 填充只改表单本地状态，不保存退出即恢复。
 */
import type { AgentConfig, AgentTemplateDTO } from '@pi-agent-platform/shared-types';
import { withMcpDependencies } from '../constants/builtin-tools';

/** 编辑表单里与模板相关的字段（agent 页与 session 页结构相同）。 */
export interface TemplateTargetConfig {
  systemPrompt?: string;
  appendSystemPrompt?: string;
  builtinTools: string[];
  mcp: { enabled: boolean };
  serverBuiltinTools: string[];
  capabilities: string[] | null;
  extensions: string[];
  skills: string[];
  prompts: string[];
}

/** 表单 → 模板快照（复制数组，避免共享引用）。 */
export function templateSnapshot(config: TemplateTargetConfig): AgentConfig {
  const mcpOn = config.mcp.enabled === true;
  return {
    // 快照与「填充后的结果」保持一致：mcp 开着就一定带上 codemode/tool_search。
    builtinTools: mcpOn ? withMcpDependencies([...config.builtinTools]) : [...config.builtinTools],
    mcp: { enabled: mcpOn },
    serverBuiltinTools: [...config.serverBuiltinTools],
    capabilities: config.capabilities === null ? null : [...config.capabilities],
    extensions: [...config.extensions],
    skills: [...config.skills],
    prompts: [...config.prompts],
  };
}

/** 模板 → 表单（整体覆盖六个资源字段 + capabilities；systemPrompt 清空）。 */
export function applyTemplate<T extends TemplateTargetConfig>(config: T, template: AgentTemplateDTO): T {
  const c = template.config;
  return {
    ...config,
    systemPrompt: '',
    appendSystemPrompt: '',
    // MCP 与 codemode/tool_search 的依赖关系不能因模板快照而破坏：
    // 模板里 mcp 开着却没勾这两项时补齐（与编辑页开关、worker 强制规则一致）。
    builtinTools: c.mcp?.enabled === true
      ? withMcpDependencies([...(c.builtinTools ?? [])])
      : [...(c.builtinTools ?? [])],
    mcp: { enabled: c.mcp?.enabled === true },
    serverBuiltinTools: [...(c.serverBuiltinTools ?? [])],
    capabilities: c.capabilities === null || c.capabilities === undefined ? null : [...c.capabilities],
    extensions: [...(c.extensions ?? [])],
    skills: [...(c.skills ?? [])],
    prompts: [...(c.prompts ?? [])],
  };
}

/** 列表/下拉里的一行摘要。 */
export interface TemplateFacet {
  key: string;
  label: string;
  value: string;
  /** `on` = 该项有内容/已启用，`off` = 空清单或关闭（弱化显示）。 */
  tone: 'on' | 'off';
}

/** 模板卡片上的分项标签（比一行拼接的摘要更易扫读）。 */
export function templateFacets(config: AgentConfig): TemplateFacet[] {
  const tools = config.builtinTools?.length ?? 0;
  const extensions = config.extensions?.length ?? 0;
  const skills = config.skills?.length ?? 0;
  const prompts = config.prompts?.length ?? 0;
  const caps = config.capabilities?.length ?? 0;
  return [
    {
      key: 'tools',
      label: '工具',
      value: `工具 ${tools}`,
      tone: tools ? 'on' : 'off',
    },
    {
      key: 'mcp',
      label: 'MCP',
      value: config.mcp?.enabled ? 'MCP 开' : 'MCP 关',
      tone: config.mcp?.enabled ? 'on' : 'off',
    },
    {
      key: 'extensions',
      label: '插件',
      value: `插件 ${extensions}`,
      tone: extensions ? 'on' : 'off',
    },
    {
      key: 'skills',
      label: 'Skill',
      value: `Skill ${skills}`,
      tone: skills ? 'on' : 'off',
    },
    {
      key: 'prompts',
      label: 'Prompt',
      value: `Prompt ${prompts}`,
      tone: prompts ? 'on' : 'off',
    },
    {
      key: 'capabilities',
      label: '能力',
      value: config.capabilities === null || config.capabilities === undefined ? '能力 未授权' : `能力 ${caps}`,
      tone: caps ? 'on' : 'off',
    },
  ];
}

export function summarizeTemplate(config: AgentConfig): string {
  const caps = config.capabilities === null || config.capabilities === undefined
    ? '未授权'
    : `${config.capabilities.length} 项`;
  return [
    `工具 ${config.builtinTools?.length ?? 0}`,
    `MCP ${config.mcp?.enabled ? '开' : '关'}`,
    `插件 ${config.extensions?.length ?? 0}`,
    `Skill ${config.skills?.length ?? 0}`,
    `Prompt ${config.prompts?.length ?? 0}`,
    `能力 ${caps}`,
  ].join(' · ');
}

export async function fetchTemplates(): Promise<AgentTemplateDTO[]> {
  const res = await fetch('/api/templates');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AgentTemplateDTO[];
}

export async function createTemplate(input: {
  name: string;
  description?: string;
  config: AgentConfig;
}): Promise<AgentTemplateDTO> {
  const res = await fetch('/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as AgentTemplateDTO;
}
