<script setup lang="ts">
/**
 * AgentEditorView — Agent 创建 / 查看 / 编辑路由页。
 *
 * 路由模式：
 *   /agents/new        → 创建
 *   /agents/:id        → 只读查看（editMode = false）
 *   /agents/:id/edit   → 编辑
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { AgentDTO } from '@pi-agent-platform/shared-types';
import EditorPage from '../../components/layout/primitives/EditorPage.vue';
import AppIcon from '../../components/ui/AppIcon.vue';
import InfoTip from '../../components/ui/InfoTip.vue';
import McpSelectionGroup from '../../components/config/McpSelectionGroup.vue';
import { toast } from '../../composables/useFeedback';
import { setCrumbName } from '../../composables/breadcrumbNames';
import {
  BASE_AGENT_CONFIG,
  BUILTIN_TOOLS,
  BUILTIN_TOOL_NAMES,
  withMcpDependencies,
  SERVER_BUILTIN_TOOLS,
} from '../../constants/builtin-tools';
import { useConfigIssues } from '../../composables/useConfigIssues';
import { useMcpCatalog } from '../../composables/useMcpCatalog';
import { normalizeAgentConfig } from '@pi-agent-platform/shared-types';
import {
  applyTemplate,
  createTemplate,
  fetchTemplates,
  templateSnapshot,
} from '../../composables/useTemplates';
import type { AgentTemplateDTO } from '@pi-agent-platform/shared-types';
import { confirmDialog } from '../../composables/useFeedback';

interface ModelOption {
  provider: string;
  modelId: string;
  displayName: string;
}

interface NamedItem {
  name: string;
}

// callServer 方法级授权（AgentConfig.capabilities）：
// null=未配置（opt-in：无任何方法权限）、[]=显式全禁、数组=授权白名单
// 方法列表从 GET /api/capabilities 拉（注册表唯一事实源，前端不硬编码）
interface CapabilityInfo {
  method: string;
  module: string;
  access: 'read' | 'write';
  scoped: boolean;
  summary: string;
}
const capabilityModules = ref<Array<{ module: string; capabilities: CapabilityInfo[] }>>([]);
const route = useRoute();
const router = useRouter();

const routeId = computed(() => {
  const raw = route.params.id;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : '';
});

/** 三种模式：create / view / edit */
const mode = computed<'create' | 'view' | 'edit'>(() => {
  if (route.path.endsWith('/new')) return 'create';
  if (route.path.endsWith('/edit')) return 'edit';
  if (routeId.value) return 'view';
  return 'create';
});
const isCreate = computed(() => mode.value === 'create');
const isView = computed(() => mode.value === 'view');
const isEdit = computed(() => mode.value === 'edit');

const loading = ref(true);
const saving = ref(false);
const loadError = ref<string | null>(null);

const allModels = ref<ModelOption[]>([]);
const availableSkills = ref<NamedItem[]>([]);
const availablePrompts = ref<NamedItem[]>([]);
const availableExtensions = ref<{ names: string[] }>({ names: [] });

function baseFormConfig() {
  return {
    systemPrompt: '',
    appendSystemPrompt: '',
    builtinTools: [...BASE_AGENT_CONFIG.builtinTools],
    mcp: { ...BASE_AGENT_CONFIG.mcp },
    serverBuiltinTools: [...BASE_AGENT_CONFIG.serverBuiltinTools],
    capabilities: null as string[] | null,
    extensions: [...BASE_AGENT_CONFIG.extensions],
    skills: [...BASE_AGENT_CONFIG.skills],
    prompts: [...BASE_AGENT_CONFIG.prompts],
  };
}

const form = ref({
  name: '',
  model: '',
  description: '',
  workspacePath: '',
  config: baseFormConfig(),
});

const issues = useConfigIssues();
const issueIndex = computed(() =>
  issues.buildIssueIndex(form.value.config, form.value.model || null),
);
const configIssues = computed(() => issues.issuesFor(form.value.config, form.value.model || null));

const canSave = computed(
  () => !!form.value.name.trim() && !!form.value.model.trim() && !!form.value.workspacePath.trim(),
);

const skillNames = computed(() => availableSkills.value.map((item) => item.name));
const promptNames = computed(() => availablePrompts.value.map((item) => item.name));

// ---- 配置模板（agent-templates）：填充是显式覆盖，只改表单本地状态 ----
const templates = ref<AgentTemplateDTO[]>([]);
const templatePick = ref('');
const templateSaving = ref(false);
const templateName = ref('');
const showTemplateSave = ref(false);

async function loadTemplates(): Promise<void> {
  try {
    templates.value = await fetchTemplates();
  } catch {
    templates.value = [];
  }
}

async function applyPickedTemplate(): Promise<void> {
  const picked = templates.value.find((t) => t.id === templatePick.value);
  if (!picked) {
    toast('请先选择一个模板', 'warning');
    return;
  }
  const ok = await confirmDialog({
    title: '从模板填充',
    message: `将用模板「${picked.name}」覆盖当前工具 / MCP / 插件 / Skill / Prompt / Server 工具 / 能力授权。名称、模型、工作区不受影响，systemPrompt 会被清空。不保存退出即恢复。`,
    confirmText: '填充',
  });
  if (!ok) return;
  form.value.config = applyTemplate(form.value.config, picked) as typeof form.value.config;
  toast(`已填充模板「${picked.name}」（未保存）`, 'success');
}

async function saveAsTemplate(): Promise<void> {
  const name = templateName.value.trim();
  if (!name) {
    toast('请填写模板名', 'warning');
    return;
  }
  if (templateSaving.value) return;
  templateSaving.value = true;
  try {
    await createTemplate({
      name,
      description: form.value.description,
      config: templateSnapshot(form.value.config),
    });
    toast(`已存为模板「${name}」`, 'success');
    templateName.value = '';
    showTemplateSave.value = false;
    await loadTemplates();
  } catch (err) {
    toast(`存为模板失败：${(err as Error).message}`, 'error');
  } finally {
    templateSaving.value = false;
  }
}

/** callServer 是否启用（显式清单）——联动 Capabilities 区显隐 */
const callServerEnabled = computed(() => form.value.config.serverBuiltinTools.includes('callServer'));

// 关掉 callServer 时清空方法级授权：capabilities 只对 callServer 有意义，留着会在重新
// 开启时悄悄复活旧授权（保存时 normalizeAgentConfig 也会兜底置 []）。
watch(callServerEnabled, (on) => {
  if (!on) form.value.config.capabilities = [];
});

/** 非空模块（channel/config 占位空组不展示） */
const capabilityGroups = computed(() => capabilityModules.value.filter((g) => g.capabilities.length > 0));
const allCapabilityMethods = computed(() => capabilityModules.value.flatMap((g) => g.capabilities.map((c) => c.method)));

function capabilitiesSummary(items: string[] | null): string {
  if (items === null) return '未授权';
  if (items.length === 0) return '0 项';
  return `${items.length} / ${allCapabilityMethods.value.length} 项`;
}

onMounted(async () => {
  void loadMcpCatalog();
  try {
    const [modelsRes, skillsRes, promptsRes, extensionsRes, agentRes, capsRes] = await Promise.all([
      fetch('/api/models'),
      fetch('/api/config/skills'),
      fetch('/api/config/prompts'),
      fetch('/api/config/extensions'),
      routeId.value ? fetch(`/api/agents/${routeId.value}`) : Promise.resolve(null),
      fetch('/api/capabilities'),
    ]);

    if (modelsRes.ok) allModels.value = (await modelsRes.json()) as ModelOption[];
    if (skillsRes.ok) availableSkills.value = (await skillsRes.json()) as NamedItem[];
    if (promptsRes.ok) availablePrompts.value = (await promptsRes.json()) as NamedItem[];
    if (extensionsRes.ok) availableExtensions.value = (await extensionsRes.json()) as { names: string[] };
    if (capsRes.ok) {
      const data = (await capsRes.json()) as { modules: Array<{ module: string; capabilities: CapabilityInfo[] }> };
      capabilityModules.value = data.modules ?? [];
    }
    if (agentRes) {
      if (!agentRes.ok) throw new Error(`HTTP ${agentRes.status}`);
      const agent = (await agentRes.json()) as AgentDTO;
      // 存量行可能缺失字段 —— 归一为空清单（与 worker 边界同一份函数）。
      const resolved = normalizeAgentConfig(agent.config);
      form.value = {
        name: agent.name,
        model: agent.model,
        description: agent.description ?? '',
        workspacePath: agent.workspacePath,
        config: {
          systemPrompt: resolved.systemPrompt ?? '',
          appendSystemPrompt: resolved.appendSystemPrompt ?? '',
          builtinTools: [...resolved.builtinTools],
          mcp: { enabled: resolved.mcp.enabled, servers: [...resolved.mcp.servers] },
          serverBuiltinTools: [...resolved.serverBuiltinTools],
          capabilities: resolved.capabilities,
          extensions: [...resolved.extensions],
          skills: [...resolved.skills],
          prompts: [...resolved.prompts],
        },
      };
      // 生效值回显：MCP 开着就一定带着 codemode/tool_search（worker 强制补齐，这里先对齐，
      // 否则页面显示未勾选、实际生效却已启用）。
      if (form.value.config.mcp.enabled) {
        form.value.config.builtinTools = withMcpDependencies(form.value.config.builtinTools);
      }
      setCrumbName(routeId.value, agent.name);
    }
  } catch (err) {
    loadError.value = `加载失败：${(err as Error).message}`;
  } finally {
    loading.value = false;
  }
  await issues.loadAvailability();
  await loadTemplates();
});

async function save(): Promise<void> {
  if (!canSave.value || saving.value) return;
  saving.value = true;
  try {
    const body = isEdit.value ? { id: routeId.value, ...form.value } : form.value;
    const url = isEdit.value ? `/api/agents/${routeId.value}` : '/api/agents';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast(isEdit.value ? 'Agent 已更新' : 'Agent 已创建', 'success');
    await router.push('/agents');
  } catch (err) {
    toast(`保存失败：${(err as Error).message}`, 'error');
  } finally {
    saving.value = false;
  }
}

function formatModel(model: string): string {
  const found = allModels.value.find((m) => `${m.provider}/${m.modelId}` === model);
  return found ? `${found.displayName} (${found.provider})` : model;
}

function resourceSummary(items: readonly string[], total: number): string {
  if (items.length === 0) return '无';
  return items.length === total ? `全部 ${total} 项` : `${items.length} / ${total} 项`;
}

/** “全选”= 展开为当前显式清单（不引入 `*` 特例，清单永远是唯一事实源）。 */
function selectAllTools(): void {
  form.value.config.builtinTools = [...BUILTIN_TOOL_NAMES];
}
function selectAllServerTools(): void {
  form.value.config.serverBuiltinTools = [...SERVER_BUILTIN_TOOLS];
}
function selectAllExtensions(): void {
  form.value.config.extensions = [...availableExtensions.value.names];
}
function selectAllSkills(): void {
  form.value.config.skills = [...skillNames.value];
}
function selectAllPrompts(): void {
  form.value.config.prompts = [...promptNames.value];
}
/** 清理某字段里当前环境中不存在的项。 */
function pruneField(
  field: 'extensions' | 'skills' | 'prompts' | 'capabilities' | 'builtinTools' | 'serverBuiltinTools',
): void {
  if (field === 'capabilities') {
    const caps = form.value.config.capabilities;
    if (caps !== null) form.value.config.capabilities = issues.pruneInvalid('capabilities', caps);
    return;
  }
  const cfg = form.value.config as unknown as Record<string, string[] | undefined>;
  const current = cfg[field] ?? [];
  cfg[field] = issues.pruneInvalid(field, current);
}

/** 授权是显式集合：勾选/取消都落成数组（null = 走全局策略，勾一下就变成显式清单）。 */
function toggleCapability(method: string, checked: boolean): void {
  const next = new Set(form.value.config.capabilities ?? []);
  if (checked) next.add(method);
  else next.delete(method);
  form.value.config.capabilities = [...next];
}

/** MCP 能力开关（显式布尔，无继承）。 */
const mcpEnabled = computed(() => form.value.config.mcp.enabled === true);

/**
 * 平台 MCP 目录（server 定义只在 `~/.pi/server/mcp.json`，这里只勾名字）。
 */
const {
  servers: mcpCatalog,
  errors: mcpCatalogErrors,
  conflicts: mcpConflicts,
  loading: mcpCatalogLoading,
  load: loadMcpCatalog,
} = useMcpCatalog();

/**
 * MCP is a capability, not a tool: the switch writes `config.mcp.enabled` and, when turned on,
 * ticks codemode + tool_search (a server's default `exposure: codemode` needs them). Turning it
 * off leaves those selections untouched. The worker enforces the same dependency, so a hand-made
 * API payload cannot produce a half-working config.
 */
watch(mcpEnabled, (on) => {
  if (!on) return;
  form.value.config.builtinTools = withMcpDependencies(form.value.config.builtinTools);
});
</script>

<template>
  <div class="agent-editor-wrap">
    <EditorPage
      :title="isCreate ? 'New Agent' : (isView ? form.name || routeId : `编辑 Agent：${form.name || routeId}`)"
      cancel-to="/agents"
      back-label="Agents"
      :can-save="isCreate || isEdit ? canSave : false"
      :saving="saving"
      @save="save"
    >
      <!-- view 模式：编辑按钮 -->
      <template v-if="isView && !loading" #actions>
        <button class="btn btn-primary" type="button" @click="router.push(`/agents/${routeId}/edit`)">
          <AppIcon name="edit" :size="15" />
          <span>编辑</span>
        </button>
      </template>

      <div v-if="loading" class="agent-editor__state">加载中...</div>
      <div v-else-if="loadError" class="agent-editor__state">{{ loadError }}</div>

      <div v-else class="agent-editor">
        <!-- 基本信息 -->
        <div class="section">
          <h3 class="section-title">基本信息</h3>
          <div class="form-grid">
            <label class="field">
              <span class="field-label">Name *</span>
              <input v-model="form.name" class="control" :disabled="isView" autocomplete="off" />
            </label>

            <label class="field">
              <span class="field-label">Model *</span>
              <template v-if="isView">
                <div class="field-readonly">{{ formatModel(form.model) }}</div>
              </template>
              <template v-else>
                <select v-model="form.model" class="control">
                  <option value="" disabled>Select model</option>
                  <option
                    v-for="model in allModels"
                    :key="`${model.provider}/${model.modelId}`"
                    :value="`${model.provider}/${model.modelId}`"
                  >
                    {{ model.displayName }} ({{ model.provider }})
                  </option>
                </select>
              </template>
            </label>

            <label class="field field-span-2">
              <span class="field-label">Description</span>
              <input v-model="form.description" class="control" :disabled="isView" autocomplete="off" />
            </label>

            <label class="field field-span-2">
              <span class="field-label">Workspace path *</span>
              <input v-model="form.workspacePath" class="control mono" :disabled="isView" autocomplete="off" />
            </label>
          </div>
        </div>

        <!-- Prompts -->
        <div class="section">
          <h3 class="section-title">Prompts</h3>
          <div class="form-grid">
            <label class="field field-span-2">
              <span class="field-label">System prompt</span>
              <textarea v-model="form.config.systemPrompt" class="control" :rows="isView ? 3 : 4" :disabled="isView" />
            </label>
            <label class="field field-span-2">
              <span class="field-label">Append system prompt</span>
              <textarea v-model="form.config.appendSystemPrompt" class="control" :rows="isView ? 3 : 4" :disabled="isView" />
            </label>
          </div>
        </div>

        <!-- Resources（常开展示）—— 单层显式清单：无“使用默认/继承全局” -->
        <div class="section resources-section">
          <div class="section-head">
            <h3 class="section-title">Resources</h3>
            <span class="section-badge">
              {{ resourceSummary(form.config.builtinTools, BUILTIN_TOOL_NAMES.length) }},
              {{ resourceSummary(form.config.serverBuiltinTools, SERVER_BUILTIN_TOOLS.length) }},
              MCP {{ mcpEnabled ? '开' : '关' }},
              {{ resourceSummary(form.config.extensions, availableExtensions.names.length) }},
              {{ resourceSummary(form.config.skills, availableSkills.length) }},
              {{ resourceSummary(form.config.prompts, availablePrompts.length) }}
            </span>
            <InfoTip
              text="这里的勾选就是该 agent 的实际生效清单（没有继承层）：不勾 = 不给。新增插件 / Skill / 工具不会自动加入已有 agent。"
            />
            <span v-if="configIssues.length" class="section-badge warn">{{ configIssues.length }} 项无效</span>
          </div>

          <div class="resources-body">
            <div v-if="!isView" class="template-bar">
              <select v-model="templatePick" class="control template-select">
                <option value="">选择模板…</option>
                <option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option>
              </select>
              <button type="button" class="btn btn-sm" :disabled="!templatePick" @click="applyPickedTemplate">从模板填充</button>
              <template v-if="showTemplateSave">
                <input v-model="templateName" class="control template-name-input" placeholder="模板名" />
                <button type="button" class="btn btn-sm btn-primary" :disabled="templateSaving" @click="saveAsTemplate">保存模板</button>
                <button type="button" class="btn btn-sm" @click="showTemplateSave = false">取消</button>
              </template>
              <button v-else type="button" class="btn btn-sm" @click="showTemplateSave = true">存为模板</button>
            </div>
            <div v-if="configIssues.length" class="issues-banner">
              <div class="issues-banner-title">{{ configIssues.length }} 项配置在当前环境中不存在：</div>
              <div class="issues-banner-list">
                <span v-for="issue in configIssues" :key="issue.field + issue.value" class="issues-item">
                  {{ issue.field }} · <strong>{{ issue.value }}</strong>（{{ issue.reason }}）
                </span>
              </div>
            </div>

            <!-- Builtin tools -->
            <div class="resource-group">
              <div class="resource-group-header">
                <span class="resource-group-title">Builtin tools</span>
                <InfoTip text="codemode / tool_search 是 pi 内置扩展工具：勾选后在 worker 里装载对应扩展。MCP 不在本列表，见下方独立开关。" />
                <span class="resource-group-count">{{ resourceSummary(form.config.builtinTools, BUILTIN_TOOL_NAMES.length) }}</span>
                <span class="resource-edit-actions" v-if="!isView">
                  <button type="button" class="btn-link" @click="selectAllTools">全选</button>
                  <button type="button" class="btn-link" @click="form.config.builtinTools = []">清空</button>
                  <button type="button" class="btn-link" @click="pruneField('builtinTools')">清理无效项</button>
                </span>
              </div>
              <div v-if="isView" class="tag-list">
                <span v-for="tool in form.config.builtinTools" :key="tool" class="tag"
                  :class="{ 'tag-invalid': issueIndex('builtinTools', tool) }">{{ tool }}</span>
                <span v-if="form.config.builtinTools.length === 0" class="resource-empty">无</span>
              </div>
              <div v-else class="tag-list editable">
                <label v-for="tool in BUILTIN_TOOLS" :key="tool.value" class="tag-check"
                  :class="{ checked: form.config.builtinTools.includes(tool.value), 'tag-invalid': issueIndex('builtinTools', tool.value) }">
                  <input type="checkbox" :value="tool.value" v-model="form.config.builtinTools" />
                  <span>{{ tool.value }}</span>
                </label>
              </div>
              <div v-if="!isView && form.config.builtinTools.length" class="tag-list editable">
                <template v-for="tool in form.config.builtinTools" :key="'bad-' + tool">
                  <label v-if="issueIndex('builtinTools', tool)" class="tag-check checked tag-invalid" title="工具不存在">
                    <input type="checkbox" :value="tool" v-model="form.config.builtinTools" />
                    <span>{{ tool }}（无效）</span>
                  </label>
                </template>
              </div>
            </div>

            <!-- Server builtin tools (serverBuiltinTools) -->
            <div class="resource-group">
              <div class="resource-group-header">
                <span class="resource-group-title">Server Builtin Tools</span>
                <InfoTip text="server 侧注入的工具。callServer = 调用 server 管理能力，具体可用方法需在下方 Capabilities 中授权。" />
                <span class="resource-group-count">{{ resourceSummary(form.config.serverBuiltinTools, SERVER_BUILTIN_TOOLS.length) }}</span>
                <span class="resource-edit-actions" v-if="!isView">
                  <button type="button" class="btn-link" @click="selectAllServerTools">全选</button>
                  <button type="button" class="btn-link" @click="form.config.serverBuiltinTools = []">清空</button>
                </span>
              </div>
              <div v-if="isView" class="tag-list">
                <span v-for="tool in form.config.serverBuiltinTools" :key="tool" class="tag">{{ tool }}</span>
                <span v-if="form.config.serverBuiltinTools.length === 0" class="resource-empty">无</span>
              </div>
              <div v-else class="tag-list editable">
                <label v-for="tool in SERVER_BUILTIN_TOOLS" :key="tool" class="tag-check"
                  :class="{ checked: form.config.serverBuiltinTools.includes(tool) }">
                  <input type="checkbox" :value="tool" v-model="form.config.serverBuiltinTools" />
                  <span>{{ tool }}</span>
                </label>
              </div>
              <div v-if="!isView && form.config.serverBuiltinTools.length" class="tag-list editable">
                <template v-for="tool in form.config.serverBuiltinTools" :key="'bad-' + tool">
                  <label v-if="issueIndex('serverBuiltinTools', tool)" class="tag-check checked tag-invalid" title="平台工具不存在">
                    <input type="checkbox" :value="tool" v-model="form.config.serverBuiltinTools" />
                    <span>{{ tool }}（无效）</span>
                  </label>
                </template>
              </div>
            </div>

            <!-- MCP：总开关 + 平台目录 server 勾选 -->
            <McpSelectionGroup
              v-model:enabled="form.config.mcp.enabled"
              v-model:servers="form.config.mcp.servers"
              :catalog="mcpCatalog"
              :errors="mcpCatalogErrors"
              :conflicts="mcpConflicts"
              :loading="mcpCatalogLoading"
              :disabled="isView"
            />

            <!-- Extensions -->
            <div class="resource-group">
              <div class="resource-group-header">
                <span class="resource-group-title">Extensions</span>
                <span class="resource-group-count">{{ resourceSummary(form.config.extensions, availableExtensions.names.length) }}</span>
                <span class="resource-edit-actions" v-if="!isView">
                  <button type="button" class="btn-link" @click="selectAllExtensions">全选</button>
                  <button type="button" class="btn-link" @click="form.config.extensions = []">清空</button>
                  <button type="button" class="btn-link" @click="pruneField('extensions')">清理无效项</button>
                </span>
              </div>
              <div v-if="isView" class="tag-list">
                <span v-for="ext in form.config.extensions" :key="ext" class="tag"
                  :class="{ 'tag-invalid': issueIndex('extensions', ext) }">{{ ext }}</span>
                <span v-if="form.config.extensions.length === 0" class="resource-empty">无</span>
              </div>
              <div v-else class="tag-list editable">
                <label v-for="ext in availableExtensions.names" :key="ext" class="tag-check"
                  :class="{ checked: form.config.extensions.includes(ext) }">
                  <input type="checkbox" :value="ext" v-model="form.config.extensions" />
                  <span>{{ ext }}</span>
                </label>
                <span v-if="availableExtensions.names.length === 0" class="resource-empty">未安装插件</span>
              </div>
              <!-- 配置里有、但环境里已不存在的项：保留可见并标黄（保存不阻断） -->
              <div v-if="form.config.extensions.length" class="tag-list editable">
                <template v-for="ext in form.config.extensions" :key="'bad-' + ext">
                  <label v-if="issueIndex('extensions', ext)" class="tag-check checked tag-invalid" :title="'插件不存在或未安装'">
                    <input type="checkbox" :value="ext" v-model="form.config.extensions" />
                    <span>{{ ext }}（无效）</span>
                  </label>
                </template>
              </div>
            </div>

            <!-- Skills -->
            <div class="resource-group">
              <div class="resource-group-header">
                <span class="resource-group-title">Skills</span>
                <span class="resource-group-count">{{ resourceSummary(form.config.skills, availableSkills.length) }}</span>
                <span class="resource-edit-actions" v-if="!isView">
                  <button type="button" class="btn-link" @click="selectAllSkills">全选</button>
                  <button type="button" class="btn-link" @click="form.config.skills = []">清空</button>
                  <button type="button" class="btn-link" @click="pruneField('skills')">清理无效项</button>
                </span>
              </div>
              <div v-if="isView" class="tag-list">
                <span v-for="skill in form.config.skills" :key="skill" class="tag"
                  :class="{ 'tag-invalid': issueIndex('skills', skill) }">{{ skill }}</span>
                <span v-if="form.config.skills.length === 0" class="resource-empty">无</span>
              </div>
              <div v-else class="tag-list editable">
                <label v-for="skill in availableSkills" :key="skill.name" class="tag-check"
                  :class="{ checked: form.config.skills.includes(skill.name) }">
                  <input type="checkbox" :value="skill.name" v-model="form.config.skills" />
                  <span>{{ skill.name }}</span>
                </label>
                <span v-if="availableSkills.length === 0" class="resource-empty">未安装 Skill</span>
              </div>
              <div v-if="!isView && form.config.skills.length" class="tag-list editable">
                <template v-for="skill in form.config.skills" :key="'bad-' + skill">
                  <label v-if="issueIndex('skills', skill)" class="tag-check checked tag-invalid" title="Skill 不存在">
                    <input type="checkbox" :value="skill" v-model="form.config.skills" />
                    <span>{{ skill }}（无效）</span>
                  </label>
                </template>
              </div>
            </div>

            <!-- Prompts -->
            <div class="resource-group">
              <div class="resource-group-header">
                <span class="resource-group-title">Prompts</span>
                <span class="resource-group-count">{{ resourceSummary(form.config.prompts, availablePrompts.length) }}</span>
                <span class="resource-edit-actions" v-if="!isView">
                  <button type="button" class="btn-link" @click="selectAllPrompts">全选</button>
                  <button type="button" class="btn-link" @click="form.config.prompts = []">清空</button>
                  <button type="button" class="btn-link" @click="pruneField('prompts')">清理无效项</button>
                </span>
              </div>
              <div v-if="isView" class="tag-list">
                <span v-for="prompt in form.config.prompts" :key="prompt" class="tag"
                  :class="{ 'tag-invalid': issueIndex('prompts', prompt) }">{{ prompt }}</span>
                <span v-if="form.config.prompts.length === 0" class="resource-empty">无</span>
              </div>
              <div v-else class="tag-list editable">
                <label v-for="prompt in availablePrompts" :key="prompt.name" class="tag-check"
                  :class="{ checked: form.config.prompts.includes(prompt.name) }">
                  <input type="checkbox" :value="prompt.name" v-model="form.config.prompts" />
                  <span>{{ prompt.name }}</span>
                </label>
                <span v-if="availablePrompts.length === 0" class="resource-empty">未安装 Prompt</span>
              </div>
              <div v-if="!isView && form.config.prompts.length" class="tag-list editable">
                <template v-for="prompt in form.config.prompts" :key="'bad-' + prompt">
                  <label v-if="issueIndex('prompts', prompt)" class="tag-check checked tag-invalid" title="Prompt 模板不存在">
                    <input type="checkbox" :value="prompt" v-model="form.config.prompts" />
                    <span>{{ prompt }}（无效）</span>
                  </label>
                </template>
              </div>
            </div>
          </div>
        </div>

        <!-- Capabilities（callServer 方法级授权） -->
        <div v-if="callServerEnabled" class="section">
          <h3 class="section-title section-head">
            Capabilities
            <InfoTip text="callServer 可调用的 server 方法授权（session 快照级）。未勾选任何方法 = 不授权，callServer 开着也只能用 list / detail；勾选即授权。" :width="340" />
          </h3>

          <template v-if="isView">
            <div v-if="form.config.capabilities === null" class="resource-default">未配置（走全局 callServer 策略）</div>
            <div v-else-if="form.config.capabilities.length === 0" class="resource-empty">已配置 0 项（未授权任何方法）</div>
            <div v-else class="tag-list">
              <span v-for="m in form.config.capabilities" :key="m" class="tag"
                :class="{ 'tag-invalid': issueIndex('capabilities', m) }">{{ m }}</span>
            </div>
          </template>
          <template v-else>
            <div class="resource-edit-actions">
              <button type="button" class="btn-link" @click="form.config.capabilities = [...allCapabilityMethods]">全选</button>
              <button type="button" class="btn-link" @click="form.config.capabilities = []">清空（全禁）</button>
              <button type="button" class="btn-link" @click="pruneField('capabilities')">清理无效项</button>
            </div>
            <div v-for="group in capabilityGroups" :key="group.module" style="margin-bottom:8px">
              <div style="font-size:12px;opacity:.7;margin:6px 0 4px;text-transform:uppercase;letter-spacing:.5px">{{ group.module }}</div>
              <div class="tag-list editable">
                <label v-for="cap in group.capabilities" :key="cap.method" class="tag-check"
                  :class="{ checked: (form.config.capabilities ?? []).includes(cap.method) }">
                  <input type="checkbox" :value="cap.method"
                    :checked="(form.config.capabilities ?? []).includes(cap.method)"
                    @change="toggleCapability(cap.method, ($event.target as HTMLInputElement).checked)" />
                  <span :title="cap.summary">{{ cap.method }}<em style="font-style:normal;opacity:.55;margin-left:4px">{{ cap.access }}{{ cap.scoped ? '·own' : '' }}</em></span>
                </label>
              </div>
            </div>
            <div style="font-size:12px;opacity:.7;line-height:1.6">
              scoped 写方法仅能操作本 agent / 本 session 自己的行（固定安全网，不可配置）。
            </div>
          </template>
        </div>
      </div>
    </EditorPage>
  </div>
</template>

<style scoped>
.agent-editor-wrap {
  max-width: 1240px;
  margin: 0 auto;
  width: 100%;
}

.agent-editor {
  max-width: 900px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.agent-editor :deep(.form-grid) {
  gap: 10px 20px;
}

.agent-editor :deep(.field) {
  gap: 3px;
}

.agent-editor :deep(.field-label) {
  font-size: 0.75rem;
  font-weight: 600;
}

.agent-editor__state {
  padding: 40px;
  color: var(--text-secondary);
  text-align: center;
}

/* --- sections --- */
.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-title {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--text);
}

.agent-editor :deep(.control) {
  min-height: 34px;
  padding: 6px 10px;
  font-size: 0.85rem;
}

.field-readonly {
  min-height: 32px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  font-size: 0.85rem;
  color: var(--text);
  background: var(--surface-subtle);
  border: 1px solid var(--border);
  border-radius: 6px;
}

/* --- resources section --- */
.resources-section {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.section-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 12px 14px;
  border: 0;
  background: var(--surface-subtle);
  cursor: pointer;
  text-align: left;
  transition: background 120ms;
}

.section-toggle:hover {
  background: var(--surface-hover);
}

.section-toggle .section-title {
  font-size: 0.88rem;
}

.section-badge {
  margin-left: auto;
  font-size: 0.75rem;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.resources-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 14px;
}

/* --- resource group --- */
.resource-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.resource-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.resource-group-title {
  font-size: 0.82rem;
  font-weight: 650;
  color: var(--text);
}

.resource-group-count {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

.resource-default {
  font-size: 0.78rem;
  color: var(--text-secondary);
  padding: 4px 8px;
  background: var(--surface-subtle);
  border-radius: 4px;
}

.resource-empty {
  font-size: 0.78rem;
  color: var(--text-tertiary);
  font-style: italic;
}

/* --- tags (view mode) --- */
.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tag {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 8px;
  font-size: 0.72rem;
  font-weight: 550;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
}

/* --- tags (edit mode) --- */
.tag-list.editable {
  gap: 4px;
}

.tag-check {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 8px;
  font-size: 0.72rem;
  font-weight: 550;
  color: var(--text-secondary);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  transition: all 120ms;
  user-select: none;
}

.tag-check input { display: none; }

.tag-check.checked {
  color: var(--accent-ink);
  background: var(--accent-soft);
  border-color: var(--accent);
}

.tag-check:not(.checked):hover {
  border-color: var(--border-strong);
}

/* --- edit helpers --- */
.checkbox-inline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.78rem;
  color: var(--text-secondary);
  cursor: pointer;
}

.resource-edit {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.resource-edit-actions {
  display: flex;
  gap: 12px;
}

.template-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  margin-bottom: 10px;
  border: 1px dashed var(--border-subtle);
  border-radius: var(--radius-sm, 8px);
}

.template-select {
  min-width: 160px;
  max-width: 260px;
}

.template-name-input {
  min-width: 140px;
  max-width: 220px;
}

.btn-link {
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}

.btn-link:hover {
  text-decoration: underline;
}

/* 无效项标注（change: explicit-agent-config） */
.section-badge.warn {
  color: #b45309;
  background: rgba(245, 158, 11, 0.15);
}

.issues-banner {
  border: 1px solid rgba(245, 158, 11, 0.45);
  background: rgba(245, 158, 11, 0.1);
  border-radius: 6px;
  padding: 8px 10px;
  margin-bottom: 10px;
  font-size: 12px;
  line-height: 1.6;
}

.issues-banner-title {
  font-weight: 600;
  color: #b45309;
  margin-bottom: 4px;
}

.issues-banner-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  color: var(--text-secondary);
}

.tag-invalid,
.tag-check.tag-invalid {
  border-color: #d97706 !important;
  color: #b45309 !important;
  background: rgba(245, 158, 11, 0.12) !important;
}
</style>
