/**
 * useConfigIssues — 标注"配置里写了但当前不存在"的值（change: explicit-agent-config）。
 *
 * 数据源（均为既有只读接口）：
 * - 插件   GET /api/config/extensions   → { names }
 * - Skill  GET /api/config/skills       → [{ name }]
 * - Prompt GET /api/config/prompts      → [{ name }]
 * - 授权   GET /api/capabilities        → { modules: [{ capabilities: [{ method }] }] }
 * - 模型   GET /api/models              → [{ provider, modelId }]
 *
 * 规则表本身在 `@pi-agent-platform/shared-types` 的 `findConfigIssues`，服务端保存时用同一份
 * 函数（服务端只校验它权威掌握的清单），所以两边不会给出互相矛盾的颜色。
 */
import { ref, type Ref } from 'vue';
import {
  findConfigIssues,
  PLATFORM_BUILTIN_TOOLS,
  PLATFORM_SERVER_TOOLS,
  type AgentConfig,
  type ConfigAvailability,
  type ConfigIssue,
} from '@pi-agent-platform/shared-types';

export type IssueField = ConfigIssue['field'];

export interface ConfigIssuesApi {
  /** 环境扫描到的可用项（页面 onMounted 时加载一次）。 */
  available: Ref<ConfigAvailability>;
  loadAvailability: () => Promise<void>;
  /** 给定配置应显示的无效项（含模型）。 */
  issuesFor: (config: AgentConfig | null | undefined, model?: string | null) => ConfigIssue[];
  /** 一次性算好，供模板里逐项标黄：`has('skills','foo')`。 */
  buildIssueIndex: (
    config: AgentConfig | null | undefined,
    model?: string | null,
  ) => (field: IssueField, value: string) => boolean;
  /** 单字段「清理无效项」：返回保留的项。 */
  pruneInvalid: (field: IssueField, values: readonly string[]) => string[];
  /** 某个值是否在当前环境中不存在（与具体 config 无关，用于「清理」按钮）。 */
  isInvalid: (field: IssueField, value: string) => boolean;
}

const KNOWN_FIELD = (available: ConfigAvailability, field: IssueField): string[] | undefined => {
  switch (field) {
    case 'extensions':
      return available.extensions;
    case 'skills':
      return available.skills;
    case 'prompts':
      return available.prompts;
    case 'capabilities':
      return available.capabilities;
    case 'builtinTools':
      return available.tools;
    case 'serverBuiltinTools':
      return available.serverTools;
    default:
      return undefined;
  }
};

export function useConfigIssues(): ConfigIssuesApi {
  const available = ref<ConfigAvailability>({
    tools: [...PLATFORM_BUILTIN_TOOLS],
    serverTools: [...PLATFORM_SERVER_TOOLS],
  });

  async function loadAvailability(): Promise<void> {
    try {
      const [extRes, skillsRes, promptsRes, capsRes, modelsRes] = await Promise.all([
        fetch('/api/config/extensions'),
        fetch('/api/config/skills'),
        fetch('/api/config/prompts'),
        fetch('/api/capabilities'),
        fetch('/api/models'),
      ]);
      const next: ConfigAvailability = { ...available.value };
      if (extRes.ok) {
        const data = (await extRes.json()) as { names?: string[] };
        next.extensions = data.names ?? [];
      }
      if (skillsRes.ok) {
        next.skills = ((await skillsRes.json()) as Array<{ name: string }>).map((s) => s.name);
      }
      if (promptsRes.ok) {
        next.prompts = ((await promptsRes.json()) as Array<{ name: string }>).map((p) => p.name);
      }
      if (capsRes.ok) {
        const data = (await capsRes.json()) as {
          modules?: Array<{ capabilities?: Array<{ method: string }> }>;
        };
        next.capabilities = (data.modules ?? []).flatMap((m) =>
          (m.capabilities ?? []).map((c) => c.method),
        );
      }
      if (modelsRes.ok) {
        next.models = ((await modelsRes.json()) as Array<{ provider: string; modelId: string }>).map(
          (m) => `${m.provider}/${m.modelId}`,
        );
      }
      available.value = next;
    } catch {
      // 标注只是辅助信息：加载失败就退化为「不标注」
    }
  }

  function isInvalid(field: IssueField, value: string): boolean {
    if (field === 'model') return false; // 模型有效性依赖调用方传入的 model 参数
    const known = KNOWN_FIELD(available.value, field);
    if (!known) return false;
    return !known.includes(value);
  }

  function issuesFor(config: AgentConfig | null | undefined, model?: string | null): ConfigIssue[] {
    const issues = findConfigIssues(config, available.value);
    if (model && available.value.models && !available.value.models.includes(model)) {
      issues.push({ field: 'model', value: model, reason: '模型不存在或未启用' });
    }
    return issues;
  }

  function buildIssueIndex(config: AgentConfig | null | undefined, model?: string | null) {
    const set = new Set(issuesFor(config, model).map((i) => `${i.field}:${i.value}`));
    return (field: IssueField, value: string) => set.has(`${field}:${value}`);
  }

  function pruneInvalid(field: IssueField, values: readonly string[]): string[] {
    return values.filter((v) => !isInvalid(field, v));
  }

  return { available, loadAvailability, issuesFor, buildIssueIndex, pruneInvalid, isInvalid };
}
