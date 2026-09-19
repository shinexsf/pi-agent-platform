<script setup lang="ts">
/**
 * ProviderEditorView — 「添加 / 编辑 Provider」路由页。
 *
 * 由改造前 `ModelsConfig.vue` 的 `.dialog-overlay .dialog-large`（~150 行模板、
 * 860px 宽居中弹框）改为全屏路由页。
 *
 * 双模式（design.md D5）：
 *   - 桌面：表单模式 / JSON 模式可切换
 *   - 紧凑（<768px）：强制 JSON 模式（表单模式在 390px 下 `form-row` 堆叠后字段密度过高）
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import EditorPage from '../../components/layout/primitives/EditorPage.vue';
import AppIcon from '../../components/ui/AppIcon.vue';
import { useIsCompact } from '../../composables/useMediaQuery';
import { toast } from '../../composables/useFeedback';
import {
  API_TYPES,
  emptyModel,
  emptyProvider,
  fetchModelsData,
  putModels,
  validateProvider,
  type ProviderConfig,
} from './models-api';

const route = useRoute();
const router = useRouter();
const isCompact = useIsCompact();

const routeName = computed(() => {
  const raw = route.params.name;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? value : '';
});
const isEditing = computed(() => routeName.value.length > 0);

const loading = ref(true);
const saving = ref(false);
const loadError = ref<string | null>(null);

/** create 模式下用户输入的名称；edit 模式下固定为路由参数 */
const providerNameInput = ref('');
const providerName = computed(() => (isEditing.value ? routeName.value : providerNameInput.value.trim()));

const provider = ref<ProviderConfig>(emptyProvider());
const jsonMode = ref(false);
/** 紧凑断点强制 JSON 模式 */
const effectiveJsonMode = computed(() => isCompact.value || jsonMode.value);
const jsonText = ref('');
const authByProvider = ref<Record<string, { type: string; key: string }>>({});
const allProviders = ref<Record<string, ProviderConfig>>({});
const showApiKey = ref(false);

onMounted(async () => {
  try {
    const data = await fetchModelsData();
    allProviders.value = data.providers;
    authByProvider.value = data.auth;
    if (isEditing.value) {
      const existing = data.providers[routeName.value];
      if (!existing) {
        loadError.value = `未找到 Provider「${routeName.value}」`;
      } else {
        provider.value = JSON.parse(JSON.stringify(existing)) as ProviderConfig;
        providerNameInput.value = routeName.value;
      }
    }
  } catch (err) {
    loadError.value = `加载失败：${(err as Error).message}`;
  } finally {
    loading.value = false;
  }
});

function toggleJsonMode(): void {
  if (jsonMode.value) {
    try {
      provider.value = JSON.parse(jsonText.value) as ProviderConfig;
      jsonMode.value = false;
    } catch (err) {
      toast(`JSON 格式错误：${(err as Error).message}`, 'error');
    }
    return;
  }
  jsonText.value = JSON.stringify(provider.value, null, 2);
  jsonMode.value = true;
}

async function save(): Promise<void> {
  if (saving.value) return;

  let incoming: ProviderConfig;
  try {
    incoming = effectiveJsonMode.value
      ? (JSON.parse(jsonText.value) as ProviderConfig)
      : provider.value;
  } catch (err) {
    toast(`JSON 格式错误：${(err as Error).message}`, 'error');
    return;
  }

  const validationError = validateProvider(providerName.value, incoming);
  if (validationError) {
    toast(validationError, 'error');
    return;
  }

  saving.value = true;
  try {
    const providers = { ...allProviders.value, [providerName.value]: incoming };
    await putModels({ providers });
    await putModels({
      auth: { ...authByProvider.value, [providerName.value]: { type: 'api_key', key: incoming.apiKey } },
    });
    toast(isEditing.value ? 'Provider 已更新' : 'Provider 已添加', 'success');
    await router.push('/config/models');
  } catch (err) {
    toast(`保存失败：${(err as Error).message}`, 'error');
  } finally {
    saving.value = false;
  }
}

function addModel(): void {
  if (!provider.value.models) provider.value.models = [];
  provider.value.models.push(emptyModel());
}

function removeModel(index: number): void {
  provider.value.models?.splice(index, 1);
}

function toggleModelInput(model: { input?: string[] }, kind: 'text' | 'image', checked: boolean): void {
  const current = model.input ?? [];
  if (checked) {
    if (!current.includes(kind)) model.input = [...current, kind];
  } else {
    model.input = current.filter((item) => item !== kind);
  }
}
</script>

<template>
  <EditorPage
    :title="isEditing ? `编辑 Provider：${routeName}` : '添加 Provider'"
    cancel-to="/config/models"
    :saving="saving"
    back-label="模型 API"
    @save="save"
  >
    <div v-if="loading" class="provider-editor__state">加载中...</div>
    <div v-else-if="loadError" class="provider-editor__state">{{ loadError }}</div>

    <div v-else class="provider-editor">
      <!-- 名称 -->
      <label class="field">
        <span class="field-label">Provider 名称 *</span>
        <input
          v-if="!isEditing"
          v-model="providerNameInput"
          class="control mono"
          type="text"
          autocomplete="off"
          placeholder="my-provider"
        />
        <input v-else class="control mono" type="text" :value="routeName" disabled />
      </label>

      <!-- 模式切换（紧凑断点强制 JSON，不渲染切换） -->
      <div v-if="!isCompact" class="provider-editor__mode">
        <button
          type="button"
          class="provider-editor__mode-btn"
          :class="{ 'is-active': !jsonMode }"
          @click="jsonMode && toggleJsonMode()"
        >
          表单
        </button>
        <button
          type="button"
          class="provider-editor__mode-btn"
          :class="{ 'is-active': jsonMode }"
          @click="!jsonMode && toggleJsonMode()"
        >
          JSON
        </button>
      </div>

      <!-- JSON 模式 -->
      <label v-if="effectiveJsonMode" class="field provider-editor__json">
        <span class="field-label">Provider JSON</span>
        <textarea v-model="jsonText" class="control mono provider-editor__json-area" spellcheck="false" />
      </label>

      <!-- 表单模式 -->
      <template v-else>
        <section class="provider-editor__section">
          <h3 class="provider-editor__section-title">Provider 配置</h3>

          <div class="form-grid">
            <label class="field">
              <span class="field-label">显示名称</span>
              <input v-model="provider.name" class="control" type="text" placeholder="My Provider" />
            </label>

            <label class="field">
              <span class="field-label">接口格式 *</span>
              <select v-model="provider.api" class="control">
                <option v-for="type in API_TYPES" :key="type.value" :value="type.value">
                  {{ type.label }}
                </option>
              </select>
            </label>

            <label class="field field-span-2">
              <span class="field-label">API 地址 *</span>
              <input v-model="provider.baseUrl" class="control mono" type="text" placeholder="https://api.example.com/v1" />
            </label>

            <label class="field field-span-2">
              <span class="field-label">API 密钥 *</span>
              <span class="provider-editor__secret">
                <input
                  v-model="provider.apiKey"
                  class="control mono"
                  :type="showApiKey ? 'text' : 'password'"
                  placeholder="sk-..."
                />
                <button
                  type="button"
                  class="provider-editor__secret-toggle"
                  :aria-label="showApiKey ? '隐藏密钥' : '显示密钥'"
                  @click="showApiKey = !showApiKey"
                >
                  <AppIcon :name="showApiKey ? 'sun' : 'moon'" :size="16" />
                </button>
              </span>
            </label>
          </div>
        </section>

        <section class="provider-editor__section">
          <div class="provider-editor__section-head">
            <h3 class="provider-editor__section-title">模型配置</h3>
            <button type="button" class="btn btn-secondary btn-sm" @click="addModel">+ 添加模型</button>
          </div>

          <div v-if="!provider.models || provider.models.length === 0" class="field-hint">
            暂无模型，点击「添加模型」开始配置
          </div>

          <div
            v-for="(model, index) in provider.models ?? []"
            :key="index"
            class="provider-editor__model"
          >
            <div class="provider-editor__model-head">
              <span class="provider-editor__model-index">模型 {{ index + 1 }}</span>
              <button
                type="button"
                class="list-delete"
                :aria-label="`删除模型 ${index + 1}`"
                @click="removeModel(index)"
              >
                <AppIcon name="trash" :size="15" />
              </button>
            </div>

            <div class="form-grid">
              <label class="field">
                <span class="field-label">模型 ID *</span>
                <input v-model="model.id" class="control mono" type="text" placeholder="model-id" />
              </label>
              <label class="field">
                <span class="field-label">显示名称 *</span>
                <input v-model="model.name" class="control" type="text" placeholder="Model Name" />
              </label>
              <label class="field">
                <span class="field-label">上下文窗口 *</span>
                <input v-model.number="model.contextWindow" class="control" type="number" placeholder="128000" />
              </label>
              <label class="field">
                <span class="field-label">最大输出 *</span>
                <input v-model.number="model.maxTokens" class="control" type="number" placeholder="4096" />
              </label>
            </div>

            <div class="provider-editor__checks">
              <label class="checkbox-item">
                <input type="checkbox" v-model="model.reasoning" />
                <span>支持推理</span>
              </label>
              <label class="checkbox-item">
                <input
                  type="checkbox"
                  :checked="model.input?.includes('text')"
                  @change="toggleModelInput(model, 'text', ($event.target as HTMLInputElement).checked)"
                />
                <span>文本输入</span>
              </label>
              <label class="checkbox-item">
                <input
                  type="checkbox"
                  :checked="model.input?.includes('image')"
                  @change="toggleModelInput(model, 'image', ($event.target as HTMLInputElement).checked)"
                />
                <span>图片输入</span>
              </label>
            </div>
          </div>
        </section>
      </template>
    </div>
  </EditorPage>
</template>

<style scoped>
.provider-editor {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 900px;
}

.provider-editor__state {
  padding: 40px;
  color: var(--text-secondary);
  text-align: center;
}

.provider-editor__mode {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-subtle);
  align-self: flex-start;
}

.provider-editor__mode-btn {
  min-height: 34px;
  padding: 6px 16px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.82rem;
  font-weight: 650;
  cursor: pointer;
}

.provider-editor__mode-btn.is-active {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.provider-editor__json {
  min-height: 0;
}

.provider-editor__json-area {
  min-height: 380px;
  resize: vertical;
  line-height: 1.6;
}

.provider-editor__section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}

.provider-editor__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.provider-editor__section-title {
  margin: 0;
  color: var(--text);
  font-size: 0.92rem;
  font-weight: 700;
}

.provider-editor__secret {
  display: flex;
  align-items: center;
  gap: 8px;
}

.provider-editor__secret-toggle {
  display: inline-flex;
  width: 40px;
  height: 40px;
  flex: none;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-subtle);
  color: var(--text-secondary);
  cursor: pointer;
}

.provider-editor__secret-toggle:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.provider-editor__model {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-subtle);
}

.provider-editor__model-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.provider-editor__model-index {
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 650;
}

.provider-editor__checks {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.list-delete {
  display: inline-flex;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.list-delete:hover {
  color: var(--danger);
}

@media (max-width: 767px) {
  .provider-editor__secret-toggle {
    width: 44px;
    height: 44px;
  }
}
</style>
