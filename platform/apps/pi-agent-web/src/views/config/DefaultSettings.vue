<script setup lang="ts">
/**
 * DefaultSettings — 默认设置管理
 *
 * 功能：
 * - defaultProvider 下拉选择
 * - defaultModel 下拉选择（联动 provider）
 * - defaultThinkingLevel 选择（根据模型动态显示可用等级）
 * - enabledModels 列表管理
 * - defaultExtensions / defaultSkills / defaultPrompts / defaultBuiltinTools 列表管理
 */
import { ref, computed, onMounted, watch } from 'vue';

// All possible thinking levels from pi SDK
const ALL_THINKING_LEVELS = [
  { value: 'off', label: '关闭' },
  { value: 'minimal', label: '极低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '很高' },
  { value: 'max', label: '最高' },
];

interface ModelInfo {
  provider: string;
  modelId: string;
  displayName: string;
  hasAuth: boolean;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
}

interface Settings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  enabledModels?: string[];
  defaultExtensions?: string[];
  defaultSkills?: string[];
  defaultPrompts?: string[];
  defaultBuiltinTools?: string[];
  [key: string]: unknown;
}

interface ResourceInfo {
  name: string;
  [key: string]: unknown;
}

const settings = ref<Settings>({});
const allModels = ref<ModelInfo[]>([]);
const allExtensions = ref<ResourceInfo[]>([]);
const allSkills = ref<ResourceInfo[]>([]);
const allPrompts = ref<ResourceInfo[]>([]);
const loading = ref(true);
const saving = ref(false);

// Builtin tools list
const BUILTIN_TOOLS = [
  { value: 'read', label: 'read (读文件)' },
  { value: 'write', label: 'write (写文件)' },
  { value: 'edit', label: 'edit (编辑文件)' },
  { value: 'bash', label: 'bash (执行命令)' },
  { value: 'grep', label: 'grep (搜索内容)' },
  { value: 'find', label: 'find (查找文件)' },
  { value: 'ls', label: 'ls (列出目录)' },
];

// 按 provider 分组的模型列表
const modelsByProvider = computed(() => {
  const grouped: Record<string, ModelInfo[]> = {};
  for (const model of allModels.value) {
    const provider = model.provider;
    if (!provider) continue;
    if (!grouped[provider]) {
      grouped[provider] = [];
    }
    grouped[provider].push(model);
  }
  return grouped;
});

// 当前选中 provider 的模型列表
const currentProviderModels = computed(() => {
  const provider = settings.value.defaultProvider;
  if (!provider) return [];
  return modelsByProvider.value[provider] ?? [];
});

// 所有可用模型（用于 enabledModels 管理）
const allAvailableModels = computed(() => {
  return allModels.value.map((m) => ({
    ...m,
    enabled: settings.value.enabledModels?.includes(`${m.provider}/${m.modelId}`) ?? false,
  }));
});

// 当前选中模型的可用思考等级
const availableThinkingLevels = computed(() => {
  if (!settings.value.defaultProvider || !settings.value.defaultModel) {
    // 没有选中模型，显示默认选项
    return [
      { value: 'off', label: '关闭' },
      { value: 'low', label: '低' },
      { value: 'medium', label: '中' },
      { value: 'high', label: '高' },
    ];
  }
  
  // 找到当前选中的模型
  const model = allModels.value.find(
    m => m.provider === settings.value.defaultProvider && m.modelId === settings.value.defaultModel
  );
  
  if (!model?.thinkingLevelMap) {
    // 模型没有 thinkingLevelMap，显示默认选项
    return [
      { value: 'off', label: '关闭' },
      { value: 'low', label: '低' },
      { value: 'medium', label: '中' },
      { value: 'high', label: '高' },
    ];
  }
  
  // 根据 thinkingLevelMap 过滤可用等级
  return ALL_THINKING_LEVELS.filter(l => model.thinkingLevelMap![l.value] !== null);
});

onMounted(async () => {
  await loadData();
});

// Watch for provider changes to validate model selection
watch(() => settings.value.defaultProvider, () => {
  if (!loading.value && settings.value.defaultProvider && settings.value.defaultModel) {
    const exists = currentProviderModels.value.some(
      (m) => m.modelId === settings.value.defaultModel
    );
    if (!exists) {
      settings.value.defaultModel = undefined;
    }
  }
});

async function loadData() {
  loading.value = true;
  try {
    const [settingsRes, serverRes, modelsRes, extensionsRes, skillsRes, promptsRes] = await Promise.all([
      fetch('/api/config/settings'),
      fetch('/api/config/server'),
      fetch('/api/models'),
      fetch('/api/config/extensions/detail'),
      fetch('/api/config/skills'),
      fetch('/api/config/prompts'),
    ]);
    const sdkSettings = await settingsRes.json();
    const serverConfig = await serverRes.json();
    // Merge: SDK settings for model config, server config for resource defaults
    settings.value = {
      ...sdkSettings,
      defaultExtensions: serverConfig.defaultExtensions,
      defaultSkills: serverConfig.defaultSkills,
      defaultPrompts: serverConfig.defaultPrompts,
      defaultBuiltinTools: serverConfig.defaultBuiltinTools,
    };
    allModels.value = await modelsRes.json();
    allExtensions.value = await extensionsRes.json();
    allSkills.value = await skillsRes.json();
    allPrompts.value = await promptsRes.json();
    // Validate defaultModel after both settings and models are loaded
    if (settings.value.defaultProvider && settings.value.defaultModel) {
      const exists = currentProviderModels.value.some(
        (m) => m.modelId === settings.value.defaultModel
      );
      if (!exists) {
        settings.value.defaultModel = undefined;
      }
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  } finally {
    loading.value = false;
  }
}

async function saveSettings() {
  saving.value = true;
  try {
    // Save SDK settings (model config)
    await fetch('/api/config/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultProvider: settings.value.defaultProvider,
        defaultModel: settings.value.defaultModel,
        defaultThinkingLevel: settings.value.defaultThinkingLevel,
        enabledModels: settings.value.enabledModels,
      }),
    });
    // Save server config (resource defaults)
    await fetch('/api/config/server', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultExtensions: settings.value.defaultExtensions,
        defaultSkills: settings.value.defaultSkills,
        defaultPrompts: settings.value.defaultPrompts,
        defaultBuiltinTools: settings.value.defaultBuiltinTools,
      }),
    });
    alert('保存成功！新配置将在创建新 session 时生效。');
  } catch (err) {
    alert('保存失败: ' + (err as Error).message);
  } finally {
    saving.value = false;
  }
}

function toggleModelEnabled(modelKey: string) {
  if (!settings.value.enabledModels) {
    settings.value.enabledModels = [];
  }

  const index = settings.value.enabledModels.indexOf(modelKey);
  if (index === -1) {
    settings.value.enabledModels.push(modelKey);
  } else {
    settings.value.enabledModels.splice(index, 1);
  }
}

function selectAllModels() {
  settings.value.enabledModels = allModels.value.map(
    (m) => `${m.provider}/${m.modelId}`
  );
}

function deselectAllModels() {
  settings.value.enabledModels = [];
}

// ── Resource list helpers (extensions/skills/prompts/builtinTools) ──

function toggleResource(key: 'defaultExtensions' | 'defaultSkills' | 'defaultPrompts' | 'defaultBuiltinTools', name: string) {
  if (!settings.value[key]) {
    settings.value[key] = [];
  }
  const arr = settings.value[key] as string[];
  const index = arr.indexOf(name);
  if (index === -1) {
    arr.push(name);
  } else {
    arr.splice(index, 1);
  }
}

function selectAllResources(key: 'defaultExtensions' | 'defaultSkills' | 'defaultPrompts' | 'defaultBuiltinTools', names: string[]) {
  settings.value[key] = [...names];
}

function deselectAllResources(key: 'defaultExtensions' | 'defaultSkills' | 'defaultPrompts' | 'defaultBuiltinTools') {
  settings.value[key] = [];
}

function isResourceEnabled(key: 'defaultExtensions' | 'defaultSkills' | 'defaultPrompts' | 'defaultBuiltinTools', name: string): boolean {
  const arr = settings.value[key];
  if (!arr) return true; // null/undefined = all enabled (default)
  return arr.includes(name);
}

// Computed names for select all buttons
const extensionNames = computed(() => allExtensions.value.map(e => e.name));
const skillNames = computed(() => allSkills.value.map(s => s.name));
const promptNames = computed(() => allPrompts.value.map(p => p.name));
const builtinToolNames = computed(() => BUILTIN_TOOLS.map(t => t.value));
</script>

<template>
  <div class="default-settings">
    <h2 class="page-title">默认设置</h2>

    <div v-if="loading" class="loading">加载中...</div>

    <div v-else class="settings-form">
      <!-- Default Provider -->
      <div class="form-group">
        <label>默认 Provider</label>
        <select v-model="settings.defaultProvider" class="form-select">
          <option value="">-- 选择 Provider --</option>
          <option v-for="provider in Object.keys(modelsByProvider)" :key="provider" :value="provider">
            {{ provider }}
          </option>
        </select>
      </div>

      <!-- Default Model -->
      <div class="form-group">
        <label>默认模型</label>
        <select v-model="settings.defaultModel" class="form-select" :disabled="!settings.defaultProvider">
          <option value="">-- 选择模型 --</option>
          <option v-for="model in currentProviderModels" :key="model.modelId" :value="model.modelId">
            {{ model.displayName || model.modelId }}
          </option>
        </select>
      </div>

      <!-- Default Thinking Level -->
      <div class="form-group">
        <label>默认 Thinking Level</label>
        <select v-model="settings.defaultThinkingLevel" class="form-select">
          <option v-for="level in availableThinkingLevels" :key="level.value" :value="level.value">
            {{ level.label }}
          </option>
        </select>
      </div>

      <!-- Enabled Models -->
      <div class="form-group">
        <div class="models-header">
          <label>启用的模型</label>
          <div class="models-actions">
            <button class="btn btn-sm btn-secondary" @click="selectAllModels">全选</button>
            <button class="btn btn-sm btn-secondary" @click="deselectAllModels">全不选</button>
          </div>
        </div>
        <div class="models-checkbox-list">
          <label v-for="model in allAvailableModels" :key="`${model.provider}/${model.modelId}`" class="checkbox-item">
            <input
              type="checkbox"
              :checked="model.enabled"
              @change="toggleModelEnabled(`${model.provider}/${model.modelId}`)"
            />
            <span class="model-label">{{ model.displayName || model.modelId }}</span>
            <span class="model-provider">({{ model.provider }})</span>
          </label>
          <div v-if="allAvailableModels.length === 0" class="empty-hint">
            暂无可用模型，请先在"模型 API"中配置 Provider
          </div>
        </div>
      </div>

      <!-- Default Enabled Extensions -->
      <div class="form-group">
        <div class="models-header">
          <label>默认启用的插件</label>
          <div class="models-actions">
            <button class="btn btn-sm btn-secondary" @click="selectAllResources('defaultExtensions', extensionNames)">全选</button>
            <button class="btn btn-sm btn-secondary" @click="deselectAllResources('defaultExtensions')">全不选</button>
          </div>
        </div>
        <div class="resource-hint">留空 = 全部启用；选中 = 仅启用选中的</div>
        <div class="models-checkbox-list">
          <label v-for="ext in allExtensions" :key="ext.name" class="checkbox-item">
            <input
              type="checkbox"
              :checked="isResourceEnabled('defaultExtensions', ext.name)"
              @change="toggleResource('defaultExtensions', ext.name)"
            />
            <span class="model-label">{{ ext.name }}</span>
          </label>
          <div v-if="allExtensions.length === 0" class="empty-hint">
            暂无已安装的插件
          </div>
        </div>
      </div>

      <!-- Default Enabled Skills -->
      <div class="form-group">
        <div class="models-header">
          <label>默认启用的 Skill</label>
          <div class="models-actions">
            <button class="btn btn-sm btn-secondary" @click="selectAllResources('defaultSkills', skillNames)">全选</button>
            <button class="btn btn-sm btn-secondary" @click="deselectAllResources('defaultSkills')">全不选</button>
          </div>
        </div>
        <div class="resource-hint">留空 = 全部启用；选中 = 仅启用选中的</div>
        <div class="models-checkbox-list">
          <label v-for="skill in allSkills" :key="skill.name" class="checkbox-item">
            <input
              type="checkbox"
              :checked="isResourceEnabled('defaultSkills', skill.name)"
              @change="toggleResource('defaultSkills', skill.name)"
            />
            <span class="model-label">{{ skill.name }}</span>
          </label>
          <div v-if="allSkills.length === 0" class="empty-hint">
            暂无可用的 Skill
          </div>
        </div>
      </div>

      <!-- Default Enabled Prompts -->
      <div class="form-group">
        <div class="models-header">
          <label>默认启用的 Prompt</label>
          <div class="models-actions">
            <button class="btn btn-sm btn-secondary" @click="selectAllResources('defaultPrompts', promptNames)">全选</button>
            <button class="btn btn-sm btn-secondary" @click="deselectAllResources('defaultPrompts')">全不选</button>
          </div>
        </div>
        <div class="resource-hint">留空 = 全部启用；选中 = 仅启用选中的</div>
        <div class="models-checkbox-list">
          <label v-for="prompt in allPrompts" :key="prompt.name" class="checkbox-item">
            <input
              type="checkbox"
              :checked="isResourceEnabled('defaultPrompts', prompt.name)"
              @change="toggleResource('defaultPrompts', prompt.name)"
            />
            <span class="model-label">{{ prompt.name }}</span>
          </label>
          <div v-if="allPrompts.length === 0" class="empty-hint">
            暂无可用的 Prompt
          </div>
        </div>
      </div>

      <!-- Default Enabled Builtin Tools -->
      <div class="form-group">
        <div class="models-header">
          <label>默认启用的内置工具</label>
          <div class="models-actions">
            <button class="btn btn-sm btn-secondary" @click="selectAllResources('defaultBuiltinTools', builtinToolNames)">全选</button>
            <button class="btn btn-sm btn-secondary" @click="deselectAllResources('defaultBuiltinTools')">全不选</button>
          </div>
        </div>
        <div class="resource-hint">留空 = 全部启用；选中 = 仅启用选中的</div>
        <div class="models-checkbox-list">
          <label v-for="tool in BUILTIN_TOOLS" :key="tool.value" class="checkbox-item">
            <input
              type="checkbox"
              :checked="isResourceEnabled('defaultBuiltinTools', tool.value)"
              @change="toggleResource('defaultBuiltinTools', tool.value)"
            />
            <span class="model-label">{{ tool.label }}</span>
          </label>
        </div>
      </div>

      <!-- Save Button -->
      <div class="form-actions">
        <button class="btn btn-primary" @click="saveSettings" :disabled="saving">
          {{ saving ? '保存中...' : '保存设置' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.default-settings {
  max-width: 600px;
}

.page-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 24px;
}

.loading {
  color: var(--text-secondary);
  padding: 40px;
  text-align: center;
}

.settings-form {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-group label {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--text);
}

.form-select {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 0.9rem;
  background: var(--bg);
  color: var(--text);
}

.form-select:focus {
  outline: none;
  border-color: var(--accent);
}

.form-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.models-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.models-actions {
  display: flex;
  gap: 8px;
}

.resource-hint {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.models-checkbox-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  max-height: 300px;
  overflow-y: auto;
}

.checkbox-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 4px;
  cursor: pointer;
}

.checkbox-item:hover {
  background: var(--surface-hover);
}

.checkbox-item input[type="checkbox"] {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.model-label {
  flex: 1;
  font-size: 0.9rem;
  color: var(--text);
}

.model-provider {
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.empty-hint {
  color: var(--text-secondary);
  font-size: 0.85rem;
  text-align: center;
  padding: 20px;
}

.form-actions {
  padding-top: 16px;
  border-top: 1px solid var(--border);
}

.btn {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 150ms ease;
}

.btn-primary {
  background: var(--accent);
  color: white;
}

.btn-primary:hover {
  opacity: 0.9;
}

.btn-secondary {
  background: var(--surface-hover);
  color: var(--text);
  border: 1px solid var(--border);
}

.btn-secondary:hover {
  background: var(--border);
}

.btn-sm {
  padding: 6px 12px;
  font-size: 0.8rem;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
