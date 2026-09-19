<script setup lang="ts">
/**
 * AgentEditorView — Agent 创建 / 编辑路由页。
 *
 * 由改造前 `AgentsListView.vue` 的 `.modal-backdrop .modal` 转为全屏路由页
 * （spec route-based-modals）。表单字段与改造前一致：
 *   name / model / description / workspacePath / systemPrompt / appendSystemPrompt
 *   + builtinTools / extensions / skills / prompts 四组「默认全部 vs 自定义」多选
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { AgentDTO } from '@pi-agent-platform/shared-types';
import EditorPage from '../../components/layout/primitives/EditorPage.vue';
import { toast } from '../../composables/useFeedback';

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
const isEditing = computed(() => routeId.value.length > 0);

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

// 模板里 `availableSkills.map(item => item.name)` 在 vue-tsc 下会丢失元素类型，
// 因此预先算好名称数组。
const skillNames = computed(() => availableSkills.value.map((item) => item.name));
const promptNames = computed(() => availablePrompts.value.map((item) => item.name));

onMounted(async () => {
  try {
    const [modelsRes, skillsRes, promptsRes, extensionsRes, agentRes] = await Promise.all([
      fetch('/api/models'),
      fetch('/api/config/skills'),
      fetch('/api/config/prompts'),
      fetch('/api/config/extensions'),
      isEditing.value ? fetch(`/api/agents/${routeId.value}`) : Promise.resolve(null),
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
    const body = isEditing.value ? { id: routeId.value, ...form.value } : form.value;
    const url = isEditing.value ? `/api/agents/${routeId.value}` : '/api/agents';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast(isEditing.value ? 'Agent 已更新' : 'Agent 已创建', 'success');
    await router.push('/agents');
  } catch (err) {
    toast(`保存失败：${(err as Error).message}`, 'error');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <EditorPage
    :title="isEditing ? `编辑 Agent：${form.name || routeId}` : 'New Agent'"
    cancel-to="/agents"
    back-label="Agents"
    :can-save="canSave"
    :saving="saving"
    @save="save"
  >
    <div v-if="loading" class="agent-editor__state">加载中...</div>
    <div v-else-if="loadError" class="agent-editor__state">{{ loadError }}</div>

    <div v-else class="agent-editor">
      <div class="form-grid">
        <label class="field">
          <span class="field-label">Name *</span>
          <input v-model="form.name" class="control" autocomplete="off" />
        </label>

        <label class="field">
          <span class="field-label">Model *</span>
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
        </label>

        <label class="field field-span-2">
          <span class="field-label">Description</span>
          <input v-model="form.description" class="control" autocomplete="off" />
        </label>

        <label class="field field-span-2">
          <span class="field-label">Workspace path *</span>
          <input v-model="form.workspacePath" class="control mono" autocomplete="off" />
        </label>

        <label class="field field-span-2">
          <span class="field-label">System prompt</span>
          <textarea v-model="form.config.systemPrompt" class="control" rows="4" />
        </label>

        <label class="field field-span-2">
          <span class="field-label">Append system prompt</span>
          <textarea v-model="form.config.appendSystemPrompt" class="control" rows="4" />
        </label>

        <!-- Builtin tools -->
        <div class="field field-span-2">
          <span class="field-label">Builtin tools</span>
          <label class="checkbox-item default-option">
            <input
              type="checkbox"
              :checked="form.config.builtinTools === null"
              @change="form.config.builtinTools = ($event.target as HTMLInputElement).checked ? null : ['read', 'write', 'edit', 'bash']"
            />
            <span>Use default (all enabled)</span>
          </label>
          <div v-if="form.config.builtinTools !== null" class="agent-editor__options">
            <div class="agent-editor__option-actions">
              <button type="button" class="btn-link" @click="form.config.builtinTools = [...BUILTIN_TOOLS]">Select All</button>
              <button type="button" class="btn-link" @click="form.config.builtinTools = []">Clear All</button>
            </div>
            <div class="agent-editor__checks">
              <label v-for="tool in BUILTIN_TOOLS" :key="tool" class="checkbox-item">
                <input type="checkbox" :value="tool" v-model="form.config.builtinTools" />
                <span>{{ tool }}</span>
              </label>
            </div>
          </div>
        </div>

        <!-- Extensions -->
        <div class="field field-span-2">
          <span class="field-label">Extensions</span>
          <label class="checkbox-item default-option">
            <input
              type="checkbox"
              :checked="form.config.extensions === null"
              @change="form.config.extensions = ($event.target as HTMLInputElement).checked ? null : []"
            />
            <span>Use default (all enabled)</span>
          </label>
          <div v-if="form.config.extensions !== null" class="agent-editor__options">
            <div class="agent-editor__option-actions">
              <button type="button" class="btn-link" @click="form.config.extensions = [...availableExtensions.names]">Select All</button>
              <button type="button" class="btn-link" @click="form.config.extensions = []">Clear All</button>
            </div>
            <div class="agent-editor__checks">
              <label v-for="ext in availableExtensions.names" :key="ext" class="checkbox-item">
                <input type="checkbox" :value="ext" v-model="form.config.extensions" />
                <span>{{ ext }}</span>
              </label>
              <span v-if="availableExtensions.names.length === 0" class="agent-editor__muted">No extensions installed</span>
            </div>
          </div>
        </div>

        <!-- Skills -->
        <div class="field field-span-2">
          <span class="field-label">Skills</span>
          <label class="checkbox-item default-option">
            <input
              type="checkbox"
              :checked="form.config.skills === null"
              @change="form.config.skills = ($event.target as HTMLInputElement).checked ? null : []"
            />
            <span>Use default (all enabled)</span>
          </label>
          <div v-if="form.config.skills !== null" class="agent-editor__options">
            <div class="agent-editor__option-actions">
              <button type="button" class="btn-link" @click="form.config.skills = skillNames">Select All</button>
              <button type="button" class="btn-link" @click="form.config.skills = []">Clear All</button>
            </div>
            <div class="agent-editor__checks">
              <label v-for="skill in availableSkills" :key="skill.name" class="checkbox-item">
                <input type="checkbox" :value="skill.name" v-model="form.config.skills" />
                <span>{{ skill.name }}</span>
              </label>
              <span v-if="availableSkills.length === 0" class="agent-editor__muted">No skills installed</span>
            </div>
          </div>
        </div>

        <!-- Prompts -->
        <div class="field field-span-2">
          <span class="field-label">Prompts</span>
          <label class="checkbox-item default-option">
            <input
              type="checkbox"
              :checked="form.config.prompts === null"
              @change="form.config.prompts = ($event.target as HTMLInputElement).checked ? null : []"
            />
            <span>Use default (all enabled)</span>
          </label>
          <div v-if="form.config.prompts !== null" class="agent-editor__options">
            <div class="agent-editor__option-actions">
              <button type="button" class="btn-link" @click="form.config.prompts = promptNames">Select All</button>
              <button type="button" class="btn-link" @click="form.config.prompts = []">Clear All</button>
            </div>
            <div class="agent-editor__checks">
              <label v-for="prompt in availablePrompts" :key="prompt.name" class="checkbox-item">
                <input type="checkbox" :value="prompt.name" v-model="form.config.prompts" />
                <span>{{ prompt.name }}</span>
              </label>
              <span v-if="availablePrompts.length === 0" class="agent-editor__muted">No prompts installed</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </EditorPage>
</template>

<style scoped>
.agent-editor {
  max-width: 900px;
}

.agent-editor__state {
  padding: 40px;
  color: var(--text-secondary);
  text-align: center;
}

.agent-editor__options {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
}

.agent-editor__option-actions {
  display: flex;
  gap: 14px;
}

.agent-editor__checks {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
}

.agent-editor__muted {
  color: var(--text-secondary);
  font-size: 0.82rem;
}
</style>
