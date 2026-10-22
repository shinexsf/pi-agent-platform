<script setup lang="ts">
/**
 * SessionDetailView — 会话详情路由页（只读查看 + 编辑模式）。
 *
 * 路由：/sessions/:id（查看） / sessions/:id/edit（编辑）
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { SessionDTO, AgentDTO } from '@pi-agent-platform/shared-types';
import EditorPage from '../../components/layout/primitives/EditorPage.vue';
import AppIcon from '../../components/ui/AppIcon.vue';
import InfoTip from '../../components/ui/InfoTip.vue';
import McpSelectionGroup from '../../components/config/McpSelectionGroup.vue';
import { toast } from '../../composables/useFeedback';
import { setCrumbName } from '../../composables/breadcrumbNames';
import {
  BASE_AGENT_CONFIG,
  BUILTIN_TOOL_NAMES,
  SERVER_BUILTIN_TOOLS,
  withMcpDependencies,
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

interface ModelOption { provider: string; modelId: string; displayName: string }

// callServer 方法级授权（AgentConfig.capabilities，快照在 sessions.config 上）：
// null=未配置（opt-in：无任何方法权限；缺 key 的存量会话继承 agent）、[]=显式全禁、数组=授权白名单
// 控制面读取：session 行有 key 用 session 的，缺 key（存量）fallback agent
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

const sessionId = computed(() => {
  const raw = route.params.id;
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v : '';
});

const mode = computed<'view' | 'edit'>(() =>
  route.path.endsWith('/edit') ? 'edit' : 'view'
);
const isView = computed(() => mode.value === 'view');

const loading = ref(true);
const saving = ref(false);
const loadError = ref<string | null>(null);

const session = ref<SessionDTO | null>(null);
const agent = ref<AgentDTO | null>(null);
const allModels = ref<ModelOption[]>([]);

// editable fields
const title = ref('');
const model = ref('');
const thinkingLevel = ref('');
// 资源清单一律是显式数组（change: explicit-agent-config）：打开编辑页显示的是"生效值"
// （session 有 key 用 session 的，否则用 agent 的归一结果），保存即把七项固化到 session 行。
const builtinTools = ref<string[]>([...BASE_AGENT_CONFIG.builtinTools]);
const mcp = ref<{ enabled: boolean; servers: string[] }>({ enabled: false, servers: [] });
const serverBuiltinTools = ref<string[]>([...BASE_AGENT_CONFIG.serverBuiltinTools]);
// callServer 方法级授权：null = 走全局策略（唯一保留的 tri-state）、[] = 全禁、数组 = 白名单
const capabilities = ref<string[] | null>(null);
const extensions = ref<string[]>([]);
const skills = ref<string[]>([]);
const prompts = ref<string[]>([]);

const issues = useConfigIssues();
const issueIndex = computed(() => issues.buildIssueIndex(
  {
    builtinTools: builtinTools.value,
    serverBuiltinTools: serverBuiltinTools.value,
    extensions: extensions.value,
    skills: skills.value,
    prompts: prompts.value,
    capabilities: capabilities.value,
    mcp: mcp.value,
  },
  model.value || null,
));
const configIssues = computed(() => issues.issuesFor(
  {
    builtinTools: builtinTools.value,
    serverBuiltinTools: serverBuiltinTools.value,
    extensions: extensions.value,
    skills: skills.value,
    prompts: prompts.value,
    capabilities: capabilities.value,
    mcp: mcp.value,
  },
  model.value || null,
));

const thinkingLevels = ['low', 'medium', 'high'];
const BUILTIN_TOOLS = BUILTIN_TOOL_NAMES;
const builtinToolCount = computed(() => BUILTIN_TOOLS.length);

const mcpEnabled = computed(() => mcp.value.enabled === true);

/** 平台 MCP 目录（server 定义只在 `~/.pi/server/mcp.json`）。 */
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
 * off leaves those selections untouched. The worker enforces the same dependency.
 */
watch(mcpEnabled, (on) => {
  if (!on) return;
  builtinTools.value = withMcpDependencies(builtinTools.value);
});

// available resources
const availableSkills = ref<{ name: string }[]>([]);
const availablePrompts = ref<{ name: string }[]>([]);
const availableExtensions = ref<{ names: string[] }>({ names: [] });
const skillNames = computed(() => availableSkills.value.map(i => i.name));
const promptNames = computed(() => availablePrompts.value.map(i => i.name));

/** callServer 是否启用（显式清单）——联动 Capabilities 区显隐 */
const callServerEnabled = computed(() => serverBuiltinTools.value.includes('callServer'));

// 关掉 callServer 时清空方法级授权（与 agent 编辑页同一规则；保存时 normalizeAgentConfig 也会兜底）
watch(callServerEnabled, (on) => {
  if (!on) capabilities.value = [];
});
const capabilityGroups = computed(() => capabilityModules.value.filter(g => g.capabilities.length > 0));
const allCapabilityMethods = computed(() => capabilityModules.value.flatMap(g => g.capabilities.map(c => c.method)));
function capabilitiesSummary(items: string[] | null): string {
  if (items === null) return '未授权';
  if (items.length === 0) return '0 项';
  return `${items.length} / ${allCapabilityMethods.value.length} 项`;
}

// ---- 配置模板（agent-templates）：填充覆盖资源七字段，只改表单本地状态 ----
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

/** 表单当前值 → 覆盖到模板目标结构（保留 systemPrompt 但 applyTemplate 会清空）。 */
function currentTemplateTarget() {
  return {
    builtinTools: builtinTools.value,
    mcp: { enabled: mcp.value.enabled === true, servers: [...mcp.value.servers] },
    serverBuiltinTools: serverBuiltinTools.value,
    capabilities: capabilities.value,
    extensions: extensions.value,
    skills: skills.value,
    prompts: prompts.value,
  };
}

function applyTarget(next: ReturnType<typeof currentTemplateTarget>): void {
  builtinTools.value = next.builtinTools;
  mcp.value = next.mcp;
  serverBuiltinTools.value = next.serverBuiltinTools;
  capabilities.value = next.capabilities;
  extensions.value = next.extensions;
  skills.value = next.skills;
  prompts.value = next.prompts;
}

async function applyPickedTemplate(): Promise<void> {
  const picked = templates.value.find((t) => t.id === templatePick.value);
  if (!picked) {
    toast('请先选择一个模板', 'warning');
    return;
  }
  const ok = await confirmDialog({
    title: '从模板填充',
    message: `将用模板「${picked.name}」覆盖当前工具 / MCP / 插件 / Skill / Prompt / Server 工具 / 能力授权。标题、模型不受影响。不保存退出即恢复。`,
    confirmText: '填充',
  });
  if (!ok) return;
  applyTarget(applyTemplate(currentTemplateTarget(), picked));
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
      description: session.value?.title ? `来自会话 ${session.value.title}` : undefined,
      config: templateSnapshot(currentTemplateTarget()),
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

onMounted(async () => {
  try {
    const [sessionRes, modelsRes, skillsRes, promptsRes, extensionsRes, capsRes] = await Promise.all([
      fetch(`/api/sessions/${sessionId.value}`),
      fetch('/api/models'),
      fetch('/api/config/skills'),
      fetch('/api/config/prompts'),
      fetch('/api/config/extensions'),
      fetch('/api/capabilities'),
    ]);

    if (!sessionRes.ok) throw new Error(`HTTP ${sessionRes.status}`);
    session.value = (await sessionRes.json()) as SessionDTO;
    if (modelsRes.ok) allModels.value = (await modelsRes.json()) as ModelOption[];
    if (skillsRes.ok) availableSkills.value = (await skillsRes.json()) as { name: string }[];
    if (promptsRes.ok) availablePrompts.value = (await promptsRes.json()) as { name: string }[];
    if (extensionsRes.ok) availableExtensions.value = (await extensionsRes.json()) as { names: string[] };
    if (capsRes.ok) {
      const data = (await capsRes.json()) as { modules: Array<{ module: string; capabilities: CapabilityInfo[] }> };
      capabilityModules.value = data.modules ?? [];
    }
    // load agent info
    if (session.value.agentId) {
      const agentRes = await fetch(`/api/agents/${session.value.agentId}`);
      if (agentRes.ok) agent.value = (await agentRes.json()) as AgentDTO;
    }

    // populate editable fields
    title.value = session.value.title ?? '';
    model.value = session.value.model;
    thinkingLevel.value = session.value.thinkingLevel ?? '';
    setCrumbName(session.value.id, session.value.title || session.value.id.slice(0, 8));
    // 生效值 = agent 归一配置 + session 行里有 key 的字段（session 优先）。
    // 这是一个"只读合成"：保存时才把这些值显式写进 session 行。
    const agentCfg = normalizeAgentConfig(agent.value?.config);
    const sc = (session.value.config ?? {}) as Record<string, unknown>;
    const pick = <K extends keyof typeof agentCfg>(key: K): typeof agentCfg[K] =>
      (sc[key as string] !== undefined ? sc[key as string] : agentCfg[key]) as typeof agentCfg[K];

    builtinTools.value = [...(pick('builtinTools') as string[])];
    mcp.value = {
      enabled: (pick('mcp') as { enabled?: boolean } | null)?.enabled === true,
      servers: [...(((pick('mcp') as { servers?: string[] } | null)?.servers) ?? [])],
    };
    serverBuiltinTools.value = [...(pick('serverBuiltinTools') as string[])];
    extensions.value = [...(pick('extensions') as string[])];
    skills.value = [...(pick('skills') as string[])];
    prompts.value = [...(pick('prompts') as string[])];
    // capabilities 保留 tri-state：session 有 key（数组/null）→ 用 session 的；
    // 缺 key（存量）→ 用 agent 的（控制面同款 fallback），保存后固化为 session 级。
    const caps = sc.capabilities as string[] | null | undefined;
    capabilities.value = caps === undefined ? agentCfg.capabilities : (caps === null ? null : [...caps]);
    // 生效值回显（同 worker 强制规则）
    if (mcp.value.enabled) builtinTools.value = withMcpDependencies(builtinTools.value);
  } catch (err) {
    loadError.value = `加载失败：${(err as Error).message}`;
  } finally {
    loading.value = false;
  }
  await issues.loadAvailability();
  void loadMcpCatalog();
  await loadTemplates();
});

async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    const body: Record<string, unknown> = {};
    if (title.value !== (session.value?.title ?? '')) body.title = title.value || undefined;
    if (model.value !== session.value?.model) body.model = model.value;
    if (thinkingLevel.value !== (session.value?.thinkingLevel ?? '')) body.thinkingLevel = thinkingLevel.value || undefined;
    // 七项显式落库（不再写 null 表示"继承"）
    body.config = {
      ...(session.value?.config ?? {}),
      builtinTools: [...builtinTools.value],
      mcp: { enabled: mcp.value.enabled, servers: [...mcp.value.servers] },
      serverBuiltinTools: [...serverBuiltinTools.value],
      capabilities: capabilities.value,
      extensions: [...extensions.value],
      skills: [...skills.value],
      prompts: [...prompts.value],
    };

    const res = await fetch(`/api/sessions/${sessionId.value}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast('会话已更新', 'success');
    router.push(`/sessions/${sessionId.value}`);
  } catch (err) {
    toast(`保存失败：${(err as Error).message}`, 'error');
  } finally {
    saving.value = false;
  }
}

function openChat(): void {
  const base = import.meta.env.BASE_URL || '/';
  const url = `${base}chat/${sessionId.value}${session.value?.agentId ? `?agentId=${session.value.agentId}` : ''}`;
  window.open(url, '_blank');
}

/** 全选 = 展开为当前显式清单。 */
function selectAllBuiltinTools(): void {
  builtinTools.value = [...BUILTIN_TOOL_NAMES];
}
function selectAllServerTools(): void {
  serverBuiltinTools.value = [...SERVER_BUILTIN_TOOLS];
}
function pruneField(field: 'extensions' | 'skills' | 'prompts' | 'capabilities' | 'builtinTools'): void {
  if (field === 'capabilities') {
    if (capabilities.value !== null) capabilities.value = issues.pruneInvalid('capabilities', capabilities.value);
    return;
  }
  const refs = { extensions, skills, prompts, builtinTools } as const;
  const target = refs[field as 'extensions' | 'skills' | 'prompts' | 'builtinTools'];
  target.value = issues.pruneInvalid(field, target.value);
}
function toggleCapability(method: string, checked: boolean): void {
  const next = new Set(capabilities.value ?? []);
  if (checked) next.add(method);
  else next.delete(method);
  capabilities.value = [...next];
}

function formatModel(m: string): string {
  const found = allModels.value.find((x) => `${x.provider}/${x.modelId}` === m);
  return found ? `${found.displayName} (${found.provider})` : m;
}

function timeAgo(ts: number): string {
  const d = Math.max(0, Date.now() - ts);
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}小时前`;
  return new Date(ts).toLocaleDateString();
}

function workerUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
</script>

<template>
  <div class="session-detail-wrap">
    <EditorPage
      :title="isView ? (session?.title || sessionId.slice(0, 8)) : `编辑会话`"
      cancel-to="/sessions"
      back-label="Sessions"
      :can-save="isView ? false : true"
      :saving="saving"
      @save="save"
    >
      <template v-if="isView && !loading" #actions>
        <button class="btn btn-primary" type="button" @click="openChat">
          <AppIcon name="sessions" :size="15" />
          <span>打开会话</span>
        </button>
        <button class="btn btn-secondary" type="button" @click="router.push(`/sessions/${sessionId}/edit`)">
          <AppIcon name="edit" :size="15" />
          <span>编辑</span>
        </button>
      </template>

      <div v-if="loading" class="sd-state">加载中...</div>
      <div v-else-if="loadError" class="sd-state">{{ loadError }}</div>

      <div v-else-if="session" class="sd-content">
        <!-- 基本信息 -->
        <div class="sd-section">
          <h3 class="sd-section-title">基本信息</h3>
          <div class="sd-grid">
            <div class="sd-field">
              <span class="sd-label">标题</span>
              <template v-if="isView">
                <div class="sd-readonly">{{ session.title || '—' }}</div>
              </template>
              <template v-else>
                <input v-model="title" class="control" placeholder="输入会话标题" />
              </template>
            </div>

            <div class="sd-field">
              <span class="sd-label">Session ID</span>
              <div class="sd-readonly mono">{{ session.id }}</div>
            </div>

            <div class="sd-field">
              <span class="sd-label">Status</span>
              <div class="sd-readonly">
                <span class="status-badge" :class="session.status === 'active' ? 'is-live' : ''">{{ session.status }}</span>
              </div>
            </div>

            <div class="sd-field sd-field-span-2">
              <span class="sd-label">Session Path</span>
              <div class="sd-readonly mono">{{ session.piSessionPath }}</div>
            </div>

            <div class="sd-field">
              <span class="sd-label">Model</span>
              <template v-if="isView">
                <div class="sd-readonly">{{ formatModel(session.model) }}</div>
              </template>
              <template v-else>
                <select v-model="model" class="control">
                  <option v-for="m in allModels" :key="`${m.provider}/${m.modelId}`" :value="`${m.provider}/${m.modelId}`">
                    {{ m.displayName }} ({{ m.provider }})
                  </option>
                </select>
              </template>
            </div>

            <div class="sd-field">
              <span class="sd-label">Thinking Level</span>
              <template v-if="isView">
                <div class="sd-readonly">{{ session.thinkingLevel ?? '—' }}</div>
              </template>
              <template v-else>
                <select v-model="thinkingLevel" class="control">
                  <option value="">默认</option>
                  <option v-for="lv in thinkingLevels" :key="lv" :value="lv">{{ lv }}</option>
                </select>
              </template>
            </div>

            <div class="sd-field" v-if="agent">
              <span class="sd-label">Agent</span>
              <div class="sd-readonly">
                <router-link :to="`/agents/${agent.id}`" class="sd-link">{{ agent.name }}</router-link>
              </div>
            </div>
          </div>
        </div>

        <!-- Worker 状态 -->
        <div class="sd-section" v-if="session.worker">
          <h3 class="sd-section-title">Worker</h3>
          <div class="sd-grid">
            <div class="sd-field">
              <span class="sd-label">PID</span>
              <div class="sd-readonly mono">{{ session.worker.pid }}</div>
            </div>
            <div class="sd-field">
              <span class="sd-label">运行时间</span>
              <div class="sd-readonly">{{ workerUptime(session.worker.uptimeMs) }}</div>
            </div>
            <div class="sd-field">
              <span class="sd-label">Pending calls</span>
              <div class="sd-readonly">{{ session.worker.pendingCalls }}</div>
            </div>
          </div>
        </div>

        <!-- 时间 -->
        <div class="sd-section">
          <h3 class="sd-section-title">时间</h3>
          <div class="sd-grid">
            <div class="sd-field">
              <span class="sd-label">创建时间</span>
              <div class="sd-readonly">{{ new Date(session.createdAt).toLocaleString() }}</div>
            </div>
            <div class="sd-field">
              <span class="sd-label">最后活跃</span>
              <div class="sd-readonly">{{ timeAgo(session.lastActiveAt) }}</div>
            </div>
          </div>
        </div>

        <!-- 资源配置（常开展示；单层显式清单：打开即显示生效值，无“使用默认”） -->
        <div class="sd-section sd-resources-section">
          <div class="sd-section-head">
            <span class="sd-section-title">Resources</span>
            <InfoTip text="这里显示的是本会话的生效清单（保存后固化到会话行，优先于 agent 配置；没有继承层）。" />
            <span v-if="configIssues.length" class="sd-badge warn">{{ configIssues.length }} 项无效</span>
          </div>

          <div class="sd-resources-body">
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
            <div class="sd-resource-group">
              <div class="sd-resource-header">
                <span class="sd-resource-title">Builtin tools</span>
                <InfoTip text="codemode / tool_search 可单独启用；MCP 不在本列表，见下方独立开关。" />
                <span class="sd-resource-count">{{ builtinTools.length }} / {{ builtinToolCount }} 项</span>
                <span v-if="!isView" class="resource-edit-actions">
                  <button type="button" class="btn-link" @click="selectAllBuiltinTools">全选</button>
                  <button type="button" class="btn-link" @click="builtinTools = []">清空</button>
                  <button type="button" class="btn-link" @click="pruneField('builtinTools')">清理无效项</button>
                </span>
              </div>
              <div v-if="isView" class="tag-list">
                <span v-for="t in builtinTools" :key="t" class="tag"
                  :class="{ 'tag-invalid': issueIndex('builtinTools', t) }">{{ t }}</span>
                <span v-if="builtinTools.length === 0" class="sd-empty">无</span>
              </div>
              <div v-else class="tag-list editable">
                <label v-for="t in BUILTIN_TOOLS" :key="t" class="tag-check"
                  :class="{ checked: builtinTools.includes(t) }">
                  <input type="checkbox" :value="t" v-model="builtinTools" /><span>{{ t }}</span>
                </label>
              </div>
              <div v-if="!isView" class="tag-list editable">
                <template v-for="t in builtinTools" :key="'bad-' + t">
                  <label v-if="issueIndex('builtinTools', t)" class="tag-check checked tag-invalid" title="工具不存在">
                    <input type="checkbox" :value="t" v-model="builtinTools" /><span>{{ t }}（无效）</span>
                  </label>
                </template>
              </div>
            </div>

            <!-- MCP：总开关 + 平台目录 server 勾选 -->
            <McpSelectionGroup
              v-model:enabled="mcp.enabled"
              v-model:servers="mcp.servers"
              :catalog="mcpCatalog"
              :errors="mcpCatalogErrors"
              :conflicts="mcpConflicts"
              :loading="mcpCatalogLoading"
              :disabled="isView"
            />

            <!-- Server builtin tools -->
            <div class="sd-resource-group">
              <div class="sd-resource-header">
                <span class="sd-resource-title">Server Builtin Tools</span>
                <InfoTip text="仅下次 spawn 生效（会话行是完整快照）。callServer 的可用方法由下方 Capabilities 授权。" :width="320" />
                <span class="sd-resource-count">{{ serverBuiltinTools.length }} / {{ SERVER_BUILTIN_TOOLS.length }} 项</span>
                <span v-if="!isView" class="resource-edit-actions">
                  <button type="button" class="btn-link" @click="selectAllServerTools">全选</button>
                  <button type="button" class="btn-link" @click="serverBuiltinTools = []">清空</button>
                </span>
              </div>
              <div v-if="isView" class="tag-list">
                <span v-for="t in serverBuiltinTools" :key="t" class="tag">{{ t }}</span>
                <span v-if="serverBuiltinTools.length === 0" class="sd-empty">无</span>
              </div>
              <div v-else class="tag-list editable">
                <label v-for="t in SERVER_BUILTIN_TOOLS" :key="t" class="tag-check"
                  :class="{ checked: serverBuiltinTools.includes(t) }">
                  <input type="checkbox" :value="t" v-model="serverBuiltinTools" /><span>{{ t }}</span>
                </label>
              </div>
              <div v-if="!isView" class="tag-list editable">
                <template v-for="t in serverBuiltinTools" :key="'bad-' + t">
                  <label v-if="issueIndex('serverBuiltinTools', t)" class="tag-check checked tag-invalid" title="平台工具不存在">
                    <input type="checkbox" :value="t" v-model="serverBuiltinTools" /><span>{{ t }}（无效）</span>
                  </label>
                </template>
              </div>
            </div>

            <!-- Extensions -->
            <div class="sd-resource-group">
              <div class="sd-resource-header">
                <span class="sd-resource-title">Extensions</span>
                <span class="sd-resource-count">{{ extensions.length }} / {{ availableExtensions.names.length }} 项</span>
                <span v-if="!isView" class="resource-edit-actions">
                  <button type="button" class="btn-link" @click="extensions = [...availableExtensions.names]">全选</button>
                  <button type="button" class="btn-link" @click="extensions = []">清空</button>
                  <button type="button" class="btn-link" @click="pruneField('extensions')">清理无效项</button>
                </span>
              </div>
              <div v-if="isView" class="tag-list">
                <span v-for="e in extensions" :key="e" class="tag"
                  :class="{ 'tag-invalid': issueIndex('extensions', e) }">{{ e }}</span>
                <span v-if="extensions.length === 0" class="sd-empty">无</span>
              </div>
              <div v-else class="tag-list editable">
                <label v-for="e in availableExtensions.names" :key="e" class="tag-check"
                  :class="{ checked: extensions.includes(e) }">
                  <input type="checkbox" :value="e" v-model="extensions" /><span>{{ e }}</span>
                </label>
                <span v-if="availableExtensions.names.length === 0" class="sd-empty">未安装插件</span>
              </div>
              <div v-if="!isView" class="tag-list editable">
                <template v-for="e in extensions" :key="'bad-' + e">
                  <label v-if="issueIndex('extensions', e)" class="tag-check checked tag-invalid" title="插件不存在或未安装">
                    <input type="checkbox" :value="e" v-model="extensions" /><span>{{ e }}（无效）</span>
                  </label>
                </template>
              </div>
            </div>

            <!-- Skills -->
            <div class="sd-resource-group">
              <div class="sd-resource-header">
                <span class="sd-resource-title">Skills</span>
                <span class="sd-resource-count">{{ skills.length }} / {{ availableSkills.length }} 项</span>
                <span v-if="!isView" class="resource-edit-actions">
                  <button type="button" class="btn-link" @click="skills = [...skillNames]">全选</button>
                  <button type="button" class="btn-link" @click="skills = []">清空</button>
                  <button type="button" class="btn-link" @click="pruneField('skills')">清理无效项</button>
                </span>
              </div>
              <div v-if="isView" class="tag-list">
                <span v-for="sk in skills" :key="sk" class="tag"
                  :class="{ 'tag-invalid': issueIndex('skills', sk) }">{{ sk }}</span>
                <span v-if="skills.length === 0" class="sd-empty">无</span>
              </div>
              <div v-else class="tag-list editable">
                <label v-for="s in availableSkills" :key="s.name" class="tag-check"
                  :class="{ checked: skills.includes(s.name) }">
                  <input type="checkbox" :value="s.name" v-model="skills" /><span>{{ s.name }}</span>
                </label>
                <span v-if="availableSkills.length === 0" class="sd-empty">未安装 Skill</span>
              </div>
              <div v-if="!isView" class="tag-list editable">
                <template v-for="sk in skills" :key="'bad-' + sk">
                  <label v-if="issueIndex('skills', sk)" class="tag-check checked tag-invalid" title="Skill 不存在">
                    <input type="checkbox" :value="sk" v-model="skills" /><span>{{ sk }}（无效）</span>
                  </label>
                </template>
              </div>
            </div>

            <!-- Prompts -->
            <div class="sd-resource-group">
              <div class="sd-resource-header">
                <span class="sd-resource-title">Prompts</span>
                <span class="sd-resource-count">{{ prompts.length }} / {{ availablePrompts.length }} 项</span>
                <span v-if="!isView" class="resource-edit-actions">
                  <button type="button" class="btn-link" @click="prompts = [...promptNames]">全选</button>
                  <button type="button" class="btn-link" @click="prompts = []">清空</button>
                  <button type="button" class="btn-link" @click="pruneField('prompts')">清理无效项</button>
                </span>
              </div>
              <div v-if="isView" class="tag-list">
                <span v-for="p in prompts" :key="p" class="tag"
                  :class="{ 'tag-invalid': issueIndex('prompts', p) }">{{ p }}</span>
                <span v-if="prompts.length === 0" class="sd-empty">无</span>
              </div>
              <div v-else class="tag-list editable">
                <label v-for="p in availablePrompts" :key="p.name" class="tag-check"
                  :class="{ checked: prompts.includes(p.name) }">
                  <input type="checkbox" :value="p.name" v-model="prompts" /><span>{{ p.name }}</span>
                </label>
                <span v-if="availablePrompts.length === 0" class="sd-empty">未安装 Prompt</span>
              </div>
              <div v-if="!isView" class="tag-list editable">
                <template v-for="p in prompts" :key="'bad-' + p">
                  <label v-if="issueIndex('prompts', p)" class="tag-check checked tag-invalid" title="Prompt 模板不存在">
                    <input type="checkbox" :value="p" v-model="prompts" /><span>{{ p }}（无效）</span>
                  </label>
                </template>
              </div>
            </div>
          </div>
        </div>

        <!-- Capabilities（callServer 方法级授权，快照在 session 行；Resources 外） -->
        <div v-if="callServerEnabled" class="sd-section">
          <h3 class="sd-section-title">
            Capabilities
            <InfoTip text="callServer 可调用的 server 方法授权（session 快照级）。未勾选任何方法 = 不授权；仅影响本会话，保存后固化不再跟随 agent。" :width="340" />
          </h3>

          <template v-if="isView">
            <div v-if="capabilities === null" class="resource-default">未配置（走全局 callServer 策略）</div>
            <div v-else-if="capabilities.length === 0" class="resource-empty">已配置 0 项（未授权任何方法）</div>
            <div v-else class="tag-list">
              <span v-for="m in capabilities" :key="m" class="tag"
                :class="{ 'tag-invalid': issueIndex('capabilities', m) }">{{ m }}</span>
            </div>
          </template>
          <template v-else>
            <div class="resource-edit-actions">
              <button type="button" class="btn-link" @click="capabilities = [...allCapabilityMethods]">全选</button>
              <button type="button" class="btn-link" @click="capabilities = []">清空（全禁）</button>
              <button type="button" class="btn-link" @click="pruneField('capabilities')">清理无效项</button>
            </div>
            <div v-for="group in capabilityGroups" :key="group.module" style="margin-bottom:8px">
              <div style="font-size:12px;opacity:.7;margin:6px 0 4px;text-transform:uppercase;letter-spacing:.5px">{{ group.module }}</div>
              <div class="tag-list editable">
                <label v-for="cap in group.capabilities" :key="cap.method" class="tag-check"
                  :class="{ checked: (capabilities ?? []).includes(cap.method) }">
                  <input type="checkbox" :value="cap.method"
                    :checked="(capabilities ?? []).includes(cap.method)"
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

        <!-- System prompt -->
        <div class="sd-section" v-if="session.config?.systemPrompt || session.config?.appendSystemPrompt">
          <h3 class="sd-section-title">System Prompt</h3>
          <div v-if="session.config.systemPrompt" class="sd-prompt-block">
            <span class="sd-label">System prompt</span>
            <pre class="sd-pre">{{ session.config.systemPrompt }}</pre>
          </div>
          <div v-if="session.config.appendSystemPrompt" class="sd-prompt-block">
            <span class="sd-label">Append system prompt</span>
            <pre class="sd-pre">{{ session.config.appendSystemPrompt }}</pre>
          </div>
        </div>
      </div>
    </EditorPage>
  </div>
</template>

<style scoped>
.session-detail-wrap {
  max-width: 1240px;
  margin: 0 auto;
  width: 100%;
}

.sd-state {
  padding: 40px;
  color: var(--text-secondary);
  text-align: center;
}

.sd-content {
  max-width: 900px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* --- sections --- */
.sd-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sd-section-title {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--text);
}

.sd-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 20px;
}

.sd-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.sd-field-span-2 { grid-column: 1 / -1; }

.sd-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.sd-readonly {
  min-height: 32px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  font-size: 0.85rem;
  color: var(--text);
  background: var(--surface-subtle);
  border: 1px solid var(--border);
  border-radius: 6px;
  word-break: break-all;
}

.sd-readonly.mono {
  font-family: var(--font-mono);
  font-size: 0.8rem;
}

.sd-link {
  color: var(--accent);
  text-decoration: none;
}

.sd-link:hover {
  text-decoration: underline;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.78rem;
  font-weight: 600;
}

.status-badge.is-live {
  color: var(--success);
}

/* --- prompt blocks --- */
.sd-prompt-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sd-pre {
  margin: 0;
  padding: 10px 12px;
  font-size: 0.78rem;
  font-family: var(--font-mono);
  line-height: 1.5;
  color: var(--text);
  background: var(--surface-subtle);
  border: 1px solid var(--border);
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow-y: auto;
}

/* --- resources --- */
.sd-resources {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* --- toggle --- */
.sd-resources-section { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.sd-toggle { display: flex; align-items: center; gap: 8px; width: 100%; padding: 12px 14px; border: 0; background: var(--surface-subtle); cursor: pointer; text-align: left; transition: background 120ms; }
.sd-toggle:hover { background: var(--surface-hover); }
.sd-toggle .sd-section-title { font-size: 0.88rem; }
.sd-section-head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.sd-resources-body { display: flex; flex-direction: column; gap: 16px; padding: 14px; }

.sd-resource-group { display: flex; flex-direction: column; gap: 4px; }
.sd-badge.warn {
  font-size: 0.75rem;
  font-weight: 600;
  color: #b45309;
  background: rgba(245, 158, 11, 0.15);
  border-radius: 4px;
  padding: 1px 6px;
}
.issues-banner {
  border: 1px solid rgba(245, 158, 11, 0.45);
  background: rgba(245, 158, 11, 0.1);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.6;
}
.issues-banner-title { font-weight: 600; color: #b45309; margin-bottom: 4px; }
.issues-banner-list { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--text-secondary); }
.tag-invalid, .tag-check.tag-invalid {
  border-color: #d97706 !important;
  color: #b45309 !important;
  background: rgba(245, 158, 11, 0.12) !important;
}
.sd-resource-header { display: flex; align-items: center; gap: 8px; }
.sd-resource-title { font-size: 0.82rem; font-weight: 650; color: var(--text); }
.sd-resource-count { font-size: 0.72rem; color: var(--text-tertiary); }
.sd-empty { font-size: 0.78rem; color: var(--text-tertiary); font-style: italic; }

.checkbox-inline { display: inline-flex; align-items: center; gap: 6px; font-size: 0.78rem; color: var(--text-secondary); cursor: pointer; }
.resource-edit { display: flex; flex-direction: column; gap: 6px; }
.resource-edit-actions { display: flex; gap: 12px; }
.btn-link { border: 0; background: none; color: var(--accent); font-size: 0.75rem; font-weight: 600; cursor: pointer; padding: 0; }
.btn-link:hover { text-decoration: underline; }

.tag-list.editable { gap: 4px; }
.tag-check { display: inline-flex; align-items: center; height: 26px; padding: 0 8px; font-size: 0.72rem; font-weight: 550; color: var(--text-secondary); background: var(--surface); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; transition: all 120ms; user-select: none; }
.tag-check input { display: none; }
.tag-check.checked { color: var(--accent-ink); background: var(--accent-soft); border-color: var(--accent); }
.tag-check:not(.checked):hover { border-color: var(--border-strong); }
.tag-check.locked { cursor: default; opacity: 0.85; }
.tag-check .tag-dep { margin-left: 4px; font-size: 0.64rem; opacity: 0.75; }

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
.template-bar .template-select { min-width: 150px; max-width: 240px; }
.template-bar .template-name-input { min-width: 130px; max-width: 200px; }
.sd-resource-hint { font-size: 0.74rem; line-height: 1.45; color: var(--text-tertiary); }

.sd-resource-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sd-resource-title {
  font-size: 0.82rem;
  font-weight: 650;
  color: var(--text);
}

.sd-empty {
  font-size: 0.78rem;
  color: var(--text-tertiary);
  font-style: italic;
}

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

.tag.tag-default {
  color: var(--text-secondary);
  background: var(--surface-subtle);
  border-style: dashed;
}

@media (max-width: 767px) {
  .sd-grid {
    grid-template-columns: 1fr;
  }
}
</style>
