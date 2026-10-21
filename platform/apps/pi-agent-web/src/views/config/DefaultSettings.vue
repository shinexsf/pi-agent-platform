<script setup lang="ts">
/**
 * DefaultSettings — 默认设置（change: explicit-agent-config）
 *
 * 只保留"默认模型"这一维度，写进 pi 自己的 `~/.pi/agent/settings.json`：
 * - defaultProvider + defaultModel —— pi TUI 新会话预选 / 模型不可用时的回落目标
 * - defaultThinkingLevel —— 新会话默认思考等级
 * - enabledModels —— 模型选择器里可选的模型集合
 *
 * agent/session 的资源清单（插件 / Skill / Prompt / 工具 / MCP / 授权）是单层显式配置，
 * 本页不再提供"全局默认"，避免出现"继承层"。
 */
import { ref, computed, onMounted, watch } from 'vue';
import { toast } from '../../composables/useFeedback';
import InfoTip from '../../components/ui/InfoTip.vue';

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
  [key: string]: unknown;
}

const settings = ref<Settings>({});
const allModels = ref<ModelInfo[]>([]);
const loading = ref(true);
const saving = ref(false);

/** 默认模型的单一控件值：`provider/model`（空串 = 未设置）。 */
const defaultModelKey = ref('');

const modelKeys = computed(() => allModels.value.map((m) => `${m.provider}/${m.modelId}`));

const modelLabelByKey = computed(() => {
  const map: Record<string, string> = {};
  for (const m of allModels.value) {
    map[`${m.provider}/${m.modelId}`] = `${m.displayName || m.modelId} (${m.provider})`;
  }
  return map;
});

/** 当前选中模型的可用思考等级 */
const availableThinkingLevels = computed(() => {
  const [provider, ...rest] = defaultModelKey.value.split('/');
  const modelId = rest.join('/');
  const model = allModels.value.find((m) => m.provider === provider && m.modelId === modelId);
  if (!model?.thinkingLevelMap) {
    return [
      { value: 'off', label: '关闭' },
      { value: 'low', label: '低' },
      { value: 'medium', label: '中' },
      { value: 'high', label: '高' },
    ];
  }
  return ALL_THINKING_LEVELS.filter((l) => model.thinkingLevelMap![l.value] !== null);
});

const allAvailableModels = computed(() =>
  allModels.value.map((m) => ({
    ...m,
    enabled: settings.value.enabledModels?.includes(`${m.provider}/${m.modelId}`) ?? false,
  })),
);

onMounted(async () => {
  await loadData();
});

async function loadData() {
  loading.value = true;
  try {
    const [settingsRes, modelsRes] = await Promise.all([
      fetch('/api/config/settings'),
      fetch('/api/models'),
    ]);
    const sdkSettings = (await settingsRes.json()) as Settings;
    settings.value = {
      defaultProvider: sdkSettings.defaultProvider,
      defaultModel: sdkSettings.defaultModel,
      defaultThinkingLevel: sdkSettings.defaultThinkingLevel,
      enabledModels: sdkSettings.enabledModels,
    };
    defaultModelKey.value =
      sdkSettings.defaultProvider && sdkSettings.defaultModel
        ? `${sdkSettings.defaultProvider}/${sdkSettings.defaultModel}`
        : '';
    allModels.value = await modelsRes.json();
  } catch (err) {
    console.error('Failed to load settings:', err);
    toast('加载默认设置失败', 'error');
  } finally {
    loading.value = false;
  }
}

// 换模型后若当前思考等级不被新模型支持，清空（让 pi 用模型默认）
watch(defaultModelKey, () => {
  if (loading.value) return;
  const allowed = availableThinkingLevels.value.map((l) => l.value);
  if (settings.value.defaultThinkingLevel && !allowed.includes(settings.value.defaultThinkingLevel)) {
    settings.value.defaultThinkingLevel = undefined;
  }
});

async function saveSettings() {
  saving.value = true;
  try {
    const [provider, ...rest] = defaultModelKey.value.split('/');
    const model = rest.join('/');
    // 未设置时写空串而不是省略键：PUT 是浅合并，省略会把旧值留下。
    const res = await fetch('/api/config/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultProvider: defaultModelKey.value ? provider : '',
        defaultModel: defaultModelKey.value ? model : '',
        defaultThinkingLevel: settings.value.defaultThinkingLevel,
        enabledModels: settings.value.enabledModels,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast('保存成功！新会话与模型选择器会立即使用该默认值。', 'success');
  } catch (err) {
    toast('保存失败: ' + (err as Error).message, 'error');
  } finally {
    saving.value = false;
  }
}

function toggleModelEnabled(modelKey: string) {
  if (!settings.value.enabledModels) settings.value.enabledModels = [];
  const index = settings.value.enabledModels.indexOf(modelKey);
  if (index === -1) settings.value.enabledModels.push(modelKey);
  else settings.value.enabledModels.splice(index, 1);
}

function selectAllModels() {
  settings.value.enabledModels = allModels.value.map((m) => `${m.provider}/${m.modelId}`);
}

function deselectAllModels() {
  settings.value.enabledModels = [];
}
</script>

<template>
  <div class="default-settings">
    <h2 class="page-title">默认设置</h2>

    <div v-if="loading" class="loading">加载中...</div>

    <div v-else class="settings-form">
      <!-- Default Model (single control: provider/model) -->
      <div class="form-group">
        <label class="field-label-line">
          默认模型
          <InfoTip
            text="pi 新会话的预选模型；agent / session 未指定或指定的模型不存在时回落到这里。写入 ~/.pi/agent/settings.json 的 defaultProvider + defaultModel。"
            :width="340"
          />
        </label>
        <select v-model="defaultModelKey" class="form-select">
          <option value="">-- 未设置 --</option>
          <option v-for="key in modelKeys" :key="key" :value="key">
            {{ modelLabelByKey[key] }}
          </option>
        </select>
      </div>

      <!-- Default Thinking Level -->
      <div class="form-group">
        <label class="field-label-line">
          默认思考等级
          <InfoTip text="pi 新会话默认的思考强度（off → max）；列表随所选默认模型的可用等级变化。" :width="280" />
        </label>
        <select v-model="settings.defaultThinkingLevel" class="form-select">
          <option :value="undefined">-- 使用模型默认 --</option>
          <option v-for="level in availableThinkingLevels" :key="level.value" :value="level.value">
            {{ level.label }}
          </option>
        </select>
      </div>

      <!-- Enabled Models -->
      <div class="form-group">
        <div class="models-header">
          <label class="field-label-line">
            启用的模型
            <InfoTip text="只影响本平台 UI 可选项与 /api/models 输出；未勾选的模型在 agent / session 里选不到。" :width="290" />
          </label>
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
  max-width: 1240px;
  margin: 0 auto;
  width: 100%;
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
  gap: 16px;
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

.field-label-line {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}


.form-select {
  width: 100%;
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

/* 紧凑断点：选择器/复选框列表适配单栏，触摸目标 >= 44px */
@media (max-width: 767px) {
  .default-settings {
    max-width: none;
  }

  .form-select {
    min-height: 36px;
    font-size: 14px;
  }

  .models-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }

  .models-actions {
    width: 100%;
  }

  .models-actions .btn {
    flex: 1;
    min-height: 44px;
  }

  .models-checkbox-list {
    max-height: none;
  }

  .checkbox-item {
    min-height: 34px;
  }

  .checkbox-item input[type="checkbox"] {
    width: 18px;
    height: 18px;
  }
}
</style>
