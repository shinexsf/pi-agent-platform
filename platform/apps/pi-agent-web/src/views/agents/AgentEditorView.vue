<script setup lang="ts">
/**
 * AgentEditorView — Agent 创建 / 查看 / 编辑路由页。
 *
 * 路由模式：
 *   /agents/new        → 创建
 *   /agents/:id        → 只读查看（editMode = false）
 *   /agents/:id/edit   → 编辑
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { AgentDTO } from '@pi-agent-platform/shared-types';
import EditorPage from '../../components/layout/primitives/EditorPage.vue';
import AppIcon from '../../components/ui/AppIcon.vue';
import { toast } from '../../composables/useFeedback';
import { setCrumbName } from '../../composables/breadcrumbNames';

interface ModelOption {
  provider: string;
  modelId: string;
  displayName: string;
}

interface NamedItem {
  name: string;
}

const BUILTIN_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];

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

const form = ref({
  name: '',
  model: '',
  description: '',
  workspacePath: '',
  config: {
    systemPrompt: '',
    appendSystemPrompt: '',
    builtinTools: null as string[] | null,
    extensions: null as string[] | null,
    skills: null as string[] | null,
    prompts: null as string[] | null,
  },
});

const canSave = computed(
  () => !!form.value.name.trim() && !!form.value.model.trim() && !!form.value.workspacePath.trim(),
);

const skillNames = computed(() => availableSkills.value.map((item) => item.name));
const promptNames = computed(() => availablePrompts.value.map((item) => item.name));

/** 资源折叠状态 */
const resourcesExpanded = ref(false);

onMounted(async () => {
  try {
    const [modelsRes, skillsRes, promptsRes, extensionsRes, agentRes] = await Promise.all([
      fetch('/api/models'),
      fetch('/api/config/skills'),
      fetch('/api/config/prompts'),
      fetch('/api/config/extensions'),
      routeId.value ? fetch(`/api/agents/${routeId.value}`) : Promise.resolve(null),
    ]);

    if (modelsRes.ok) allModels.value = (await modelsRes.json()) as ModelOption[];
    if (skillsRes.ok) availableSkills.value = (await skillsRes.json()) as NamedItem[];
    if (promptsRes.ok) availablePrompts.value = (await promptsRes.json()) as NamedItem[];
    if (extensionsRes.ok) availableExtensions.value = (await extensionsRes.json()) as { names: string[] };

    if (agentRes) {
      if (!agentRes.ok) throw new Error(`HTTP ${agentRes.status}`);
      const agent = (await agentRes.json()) as AgentDTO;
      form.value = {
        name: agent.name,
        model: agent.model,
        description: agent.description ?? '',
        workspacePath: agent.workspacePath,
        config: {
          systemPrompt: agent.config?.systemPrompt ?? '',
          appendSystemPrompt: agent.config?.appendSystemPrompt ?? '',
          builtinTools: agent.config?.builtinTools ?? null,
          extensions: agent.config?.extensions ?? null,
          skills: agent.config?.skills ?? null,
          prompts: agent.config?.prompts ?? null,
        },
      };
      setCrumbName(routeId.value, agent.name);
    }
  } catch (err) {
    loadError.value = `加载失败：${(err as Error).message}`;
  } finally {
    loading.value = false;
  }
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

function resourceSummary(items: string[] | null, total: number): string {
  if (items === null) return `默认（全部 ${total} 项）`;
  if (items.length === 0) return '无';
  return items.length === total ? `全部 ${total} 项` : `${items.length} / ${total} 项`;
}
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

        <!-- Resources（折叠） -->
        <div class="section resources-section">
          <button type="button" class="section-toggle" @click="resourcesExpanded = !resourcesExpanded">
            <AppIcon :name="resourcesExpanded ? 'chevron-down' : 'chevron-right'" :size="16" />
            <span class="section-title">Resources</span>
            <span class="section-badge" v-if="!resourcesExpanded">
              {{ resourceSummary(form.config.builtinTools, BUILTIN_TOOLS.length) }},
              {{ resourceSummary(form.config.extensions, availableExtensions.names.length) }},
              {{ resourceSummary(form.config.skills, availableSkills.length) }},
              {{ resourceSummary(form.config.prompts, availablePrompts.length) }}
            </span>
          </button>

          <div v-if="resourcesExpanded" class="resources-body">
            <!-- Builtin tools -->
            <div class="resource-group">
              <div class="resource-group-header">
                <span class="resource-group-title">Builtin tools</span>
                <span class="resource-group-count">{{ resourceSummary(form.config.builtinTools, BUILTIN_TOOLS.length) }}</span>
              </div>
              <template v-if="isView">
                <div v-if="form.config.builtinTools === null" class="resource-default">默认（全部 {{ BUILTIN_TOOLS.length }} 项）</div>
                <div v-else class="tag-list">
                  <span v-for="tool in form.config.builtinTools" :key="tool" class="tag">{{ tool }}</span>
                  <span v-if="form.config.builtinTools.length === 0" class="resource-empty">无</span>
                </div>
              </template>
              <template v-else>
                <label class="checkbox-inline">
                  <input type="checkbox" :checked="form.config.builtinTools === null"
                    @change="form.config.builtinTools = ($event.target as HTMLInputElement).checked ? null : [...BUILTIN_TOOLS]" />
                  <span>使用默认</span>
                </label>
                <div v-if="form.config.builtinTools !== null" class="resource-edit">
                  <div class="resource-edit-actions">
                    <button type="button" class="btn-link" @click="form.config.builtinTools = [...BUILTIN_TOOLS]">全选</button>
                    <button type="button" class="btn-link" @click="form.config.builtinTools = []">清空</button>
                  </div>
                  <div class="tag-list editable">
                    <label v-for="tool in BUILTIN_TOOLS" :key="tool" class="tag-check"
                      :class="{ checked: form.config.builtinTools.includes(tool) }">
                      <input type="checkbox" :value="tool" v-model="form.config.builtinTools" />
                      <span>{{ tool }}</span>
                    </label>
                  </div>
                </div>
              </template>
            </div>

            <!-- Extensions -->
            <div class="resource-group">
              <div class="resource-group-header">
                <span class="resource-group-title">Extensions</span>
                <span class="resource-group-count">{{ resourceSummary(form.config.extensions, availableExtensions.names.length) }}</span>
              </div>
              <template v-if="isView">
                <div v-if="form.config.extensions === null" class="resource-default">默认（全部 {{ availableExtensions.names.length }} 项）</div>
                <div v-else class="tag-list">
                  <span v-for="ext in form.config.extensions" :key="ext" class="tag">{{ ext }}</span>
                  <span v-if="form.config.extensions.length === 0" class="resource-empty">无</span>
                </div>
              </template>
              <template v-else>
                <label class="checkbox-inline">
                  <input type="checkbox" :checked="form.config.extensions === null"
                    @change="form.config.extensions = ($event.target as HTMLInputElement).checked ? null : []" />
                  <span>使用默认</span>
                </label>
                <div v-if="form.config.extensions !== null" class="resource-edit">
                  <div class="resource-edit-actions">
                    <button type="button" class="btn-link" @click="form.config.extensions = [...availableExtensions.names]">全选</button>
                    <button type="button" class="btn-link" @click="form.config.extensions = []">清空</button>
                  </div>
                  <div class="tag-list editable">
                    <label v-for="ext in availableExtensions.names" :key="ext" class="tag-check"
                      :class="{ checked: form.config.extensions.includes(ext) }">
                      <input type="checkbox" :value="ext" v-model="form.config.extensions" />
                      <span>{{ ext }}</span>
                    </label>
                    <span v-if="availableExtensions.names.length === 0" class="resource-empty">未安装插件</span>
                  </div>
                </div>
              </template>
            </div>

            <!-- Skills -->
            <div class="resource-group">
              <div class="resource-group-header">
                <span class="resource-group-title">Skills</span>
                <span class="resource-group-count">{{ resourceSummary(form.config.skills, availableSkills.length) }}</span>
              </div>
              <template v-if="isView">
                <div v-if="form.config.skills === null" class="resource-default">默认（全部 {{ availableSkills.length }} 项）</div>
                <div v-else class="tag-list">
                  <span v-for="skill in form.config.skills" :key="skill" class="tag">{{ skill }}</span>
                  <span v-if="form.config.skills.length === 0" class="resource-empty">无</span>
                </div>
              </template>
              <template v-else>
                <label class="checkbox-inline">
                  <input type="checkbox" :checked="form.config.skills === null"
                    @change="form.config.skills = ($event.target as HTMLInputElement).checked ? null : []" />
                  <span>使用默认</span>
                </label>
                <div v-if="form.config.skills !== null" class="resource-edit">
                  <div class="resource-edit-actions">
                    <button type="button" class="btn-link" @click="form.config.skills = skillNames">全选</button>
                    <button type="button" class="btn-link" @click="form.config.skills = []">清空</button>
                  </div>
                  <div class="tag-list editable">
                    <label v-for="skill in availableSkills" :key="skill.name" class="tag-check"
                      :class="{ checked: form.config.skills.includes(skill.name) }">
                      <input type="checkbox" :value="skill.name" v-model="form.config.skills" />
                      <span>{{ skill.name }}</span>
                    </label>
                    <span v-if="availableSkills.length === 0" class="resource-empty">未安装 Skill</span>
                  </div>
                </div>
              </template>
            </div>

            <!-- Prompts -->
            <div class="resource-group">
              <div class="resource-group-header">
                <span class="resource-group-title">Prompts</span>
                <span class="resource-group-count">{{ resourceSummary(form.config.prompts, availablePrompts.length) }}</span>
              </div>
              <template v-if="isView">
                <div v-if="form.config.prompts === null" class="resource-default">默认（全部 {{ availablePrompts.length }} 项）</div>
                <div v-else class="tag-list">
                  <span v-for="prompt in form.config.prompts" :key="prompt" class="tag">{{ prompt }}</span>
                  <span v-if="form.config.prompts.length === 0" class="resource-empty">无</span>
                </div>
              </template>
              <template v-else>
                <label class="checkbox-inline">
                  <input type="checkbox" :checked="form.config.prompts === null"
                    @change="form.config.prompts = ($event.target as HTMLInputElement).checked ? null : []" />
                  <span>使用默认</span>
                </label>
                <div v-if="form.config.prompts !== null" class="resource-edit">
                  <div class="resource-edit-actions">
                    <button type="button" class="btn-link" @click="form.config.prompts = promptNames">全选</button>
                    <button type="button" class="btn-link" @click="form.config.prompts = []">清空</button>
                  </div>
                  <div class="tag-list editable">
                    <label v-for="prompt in availablePrompts" :key="prompt.name" class="tag-check"
                      :class="{ checked: form.config.prompts.includes(prompt.name) }">
                      <input type="checkbox" :value="prompt.name" v-model="form.config.prompts" />
                      <span>{{ prompt.name }}</span>
                    </label>
                    <span v-if="availablePrompts.length === 0" class="resource-empty">未安装 Prompt</span>
                  </div>
                </div>
              </template>
            </div>
          </div>
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

.tag-check:hover {
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
</style>
