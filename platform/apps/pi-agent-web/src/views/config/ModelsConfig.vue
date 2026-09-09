<script setup lang="ts">
/**
 * ModelsConfig — 模型 API 配置管理
 *
 * 两种模式：
 * 1. 有供应商模式：选择内置 provider + 填 API key
 * 2. 自定义模式：完整配置（表单 + JSON 切换）
 */
import { ref, computed, onMounted } from 'vue';

interface BuiltinProvider {
  id: string;
  name: string;
  api: string;
}

interface ProviderConfig {
  name?: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  compat?: Record<string, unknown>;
  models?: Array<{
    id: string;
    name: string;
    reasoning?: boolean;
    input?: string[];
    contextWindow?: number;
    maxTokens?: number;
  }>;
}

interface ModelsData {
  providers: Record<string, ProviderConfig>;
  auth: Record<string, { type: string; key: string }>;
}

// State
const data = ref<ModelsData>({ providers: {}, auth: {} });
const builtinProviders = ref<BuiltinProvider[]>([]);
const loading = ref(true);
const saving = ref(false);
const searchQuery = ref('');
const testing = ref<Record<string, boolean>>({});
const testResults = ref<Record<string, { ok: boolean; message: string }>>({});
const showApiKeys = ref<Record<string, boolean>>({});

// Config mode
const configMode = ref<'builtin' | 'custom'>('builtin');
const showAddDialog = ref(false);

// Builtin mode
const selectedBuiltinProvider = ref('');
const builtinApiKey = ref('');

// Custom mode
const editingProvider = ref<ProviderConfig | null>(null);
const editingProviderName = ref('');
const editJsonMode = ref(false);
const editJsonText = ref('');

// Available API types for dropdown
const apiTypes = [
  { value: 'openai-completions', label: 'OpenAI Completions (兼容)' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
  { value: 'google-vertex', label: 'Google Vertex' },
  { value: 'mistral-conversations', label: 'Mistral Conversations' },
  { value: 'bedrock-converse-stream', label: 'AWS Bedrock' },
  { value: 'azure-openai-responses', label: 'Azure OpenAI' },
];

function getProviderModelsText(provider: ProviderConfig): string {
  if (!provider.models || provider.models.length === 0) return '';
  return provider.models.map(m => m.name || m.id).join(', ');
}

onMounted(async () => {
  await loadData();
});

async function loadData() {
  loading.value = true;
  try {
    const [modelsRes, providersRes] = await Promise.all([
      fetch('/api/config/models'),
      fetch('/api/config/builtin-providers'),
    ]);
    data.value = await modelsRes.json();
    builtinProviders.value = await providersRes.json();
  } catch (err) {
    console.error('Failed to load models:', err);
  } finally {
    loading.value = false;
  }
}

// ===== Builtin Provider Mode =====

async function saveBuiltinProvider() {
  if (!selectedBuiltinProvider.value || !builtinApiKey.value) {
    alert('请选择 Provider 并填写 API Key');
    return;
  }

  saving.value = true;
  try {
    await fetch('/api/config/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        builtinProvider: {
          name: selectedBuiltinProvider.value,
          apiKey: builtinApiKey.value,
        },
      }),
    });
    alert('保存成功');
    await loadData();
  } catch (err) {
    alert('保存失败: ' + (err as Error).message);
  } finally {
    saving.value = false;
  }
}

function getBuiltinProviderStatus(providerId: string): boolean {
  return !!data.value.auth[providerId]?.key;
}

function getBuiltinApiKey(providerId: string): string {
  return data.value.auth[providerId]?.key ?? '';
}

// Filtered and sorted builtin providers
const filteredBuiltinProviders = computed(() => {
  let providers = builtinProviders.value;
  
  // Filter by search query
  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase();
    providers = providers.filter(p => 
      p.name.toLowerCase().includes(query) || 
      p.id.toLowerCase().includes(query)
    );
  }
  
  // Sort: configured first
  return [...providers].sort((a, b) => {
    const aConfigured = getBuiltinProviderStatus(a.id);
    const bConfigured = getBuiltinProviderStatus(b.id);
    if (aConfigured && !bConfigured) return -1;
    if (!aConfigured && bConfigured) return 1;
    return a.name.localeCompare(b.name);
  });
});

// ===== Custom Provider Mode =====

function startAddCustomProvider() {
  editingProvider.value = {
    baseUrl: '',
    apiKey: '',
    api: 'openai-completions',
    models: [],
  };
  editingProviderName.value = '';
  editJsonMode.value = false;
  editJsonText.value = '';
  showAddDialog.value = true;
}

function startEditProvider(name: string) {
  const provider = data.value.providers[name];
  if (!provider) return;

  editingProvider.value = JSON.parse(JSON.stringify(provider));
  editingProviderName.value = name;
  editJsonMode.value = false;
  editJsonText.value = '';
  showAddDialog.value = true;
}

function toggleJsonMode() {
  if (editJsonMode.value) {
    // 切换回表单：解析 JSON
    try {
      editingProvider.value = JSON.parse(editJsonText.value);
      editJsonMode.value = false;
    } catch (err) {
      alert('JSON 格式错误: ' + (err as Error).message);
    }
  } else {
    // 切换到 JSON：序列化
    editJsonText.value = JSON.stringify(editingProvider.value, null, 2);
    editJsonMode.value = true;
  }
}

async function saveCustomProvider() {
  if (!editingProvider.value || !editingProviderName.value) {
    alert('请填写 Provider 名称');
    return;
  }

  const provider = editingProvider.value;

  // 验证必填字段
  if (!provider.baseUrl || !provider.apiKey || !provider.api) {
    alert('请填写必填字段：API 地址、API 密钥、接口格式');
    return;
  }

  if (provider.models && provider.models.length > 0) {
    for (const model of provider.models) {
      if (!model.id || !model.name || !model.contextWindow || !model.maxTokens) {
        alert('模型配置不完整：请填写模型 ID、名称、上下文窗口、最大输出');
        return;
      }
    }
  }

  saving.value = true;
  try {
    // 更新 providers.json
    const providers = { ...data.value.providers };
    providers[editingProviderName.value] = provider;
    await fetch('/api/config/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers }),
    });

    // 更新 auth.json
    const auth = { ...data.value.auth };
    auth[editingProviderName.value] = { type: 'api_key', key: provider.apiKey };
    await fetch('/api/config/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth }),
    });

    alert('保存成功');
    showAddDialog.value = false;
    await loadData();
  } catch (err) {
    alert('保存失败: ' + (err as Error).message);
  } finally {
    saving.value = false;
  }
}

async function deleteProvider(name: string) {
  if (!confirm(`确定要删除 Provider "${name}" 吗？`)) return;

  try {
    const providers = { ...data.value.providers };
    delete providers[name];
    await fetch('/api/config/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers }),
    });
    await loadData();
  } catch (err) {
    alert('删除失败: ' + (err as Error).message);
  }
}

async function testConnection(providerName: string) {
  const provider = data.value.providers[providerName];
  if (!provider) return;

  testing.value[providerName] = true;
  testResults.value[providerName] = { ok: false, message: '测试中...' };

  try {
    const res = await fetch('/api/config/models/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: providerName,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
      }),
    });
    testResults.value[providerName] = await res.json();
  } catch (err) {
    testResults.value[providerName] = { ok: false, message: (err as Error).message };
  } finally {
    testing.value[providerName] = false;
  }
}

function toggleApiKeyVisibility(key: string) {
  showApiKeys.value[key] = !showApiKeys.value[key];
}

// Model management
function addModel() {
  if (!editingProvider.value) return;
  if (!editingProvider.value.models) {
    editingProvider.value.models = [];
  }
  editingProvider.value.models.push({
    id: '',
    name: '',
    reasoning: false,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 4096,
  });
}

function removeModel(index: number) {
  if (!editingProvider.value?.models) return;
  editingProvider.value.models.splice(index, 1);
}
</script>

<template>
  <div class="models-config">
    <h2 class="page-title">模型 API 配置</h2>

    <div v-if="loading" class="loading">加载中...</div>

    <div v-else>
      <!-- Config Mode Toggle -->
      <div class="mode-toggle">
        <label class="radio-label">
          <input type="radio" v-model="configMode" value="builtin" />
          <span>选择供应商</span>
        </label>
        <label class="radio-label">
          <input type="radio" v-model="configMode" value="custom" />
          <span>自定义配置</span>
        </label>
      </div>

      <!-- Builtin Provider Mode -->
      <div v-if="configMode === 'builtin'" class="builtin-section">
        <!-- Top actions -->
        <div class="builtin-top-actions">
          <div class="search-box">
            <input
              v-model="searchQuery"
              type="text"
              class="form-input"
              placeholder="搜索供应商..."
            />
            <span class="search-icon">🔍</span>
          </div>
          <button class="btn btn-primary" @click="saveBuiltinProvider" :disabled="saving">
            {{ saving ? '保存中...' : '保存配置' }}
          </button>
        </div>

        <p class="section-hint">
          选择一个内置供应商，只需填写 API Key
          <span v-if="searchQuery">（已过滤：{{ filteredBuiltinProviders.length }} 个）</span>
        </p>

        <div class="builtin-grid">
          <div
            v-for="provider in filteredBuiltinProviders"
            :key="provider.id"
            :class="['builtin-card', { configured: getBuiltinProviderStatus(provider.id) }]"
          >
            <div class="builtin-header">
              <span class="builtin-name">{{ provider.name }}</span>
              <span v-if="getBuiltinProviderStatus(provider.id)" class="status-badge">已配置</span>
            </div>
            <div class="builtin-api">{{ provider.api }}</div>
            <div class="builtin-key">
              <input
                :type="showApiKeys[provider.id] ? 'text' : 'password'"
                :value="getBuiltinApiKey(provider.id)"
                placeholder="API Key"
                class="form-input"
                @change="(e: Event) => { const t = e.target as HTMLInputElement; data.auth[provider.id] = { type: 'api_key', key: t.value } }"
              />
              <button class="btn-icon" @click="toggleApiKeyVisibility(provider.id)">
                {{ showApiKeys[provider.id] ? '👁️' : '👁️‍🗨️' }}
              </button>
            </div>
          </div>

          <div v-if="filteredBuiltinProviders.length === 0" class="empty-search">
            没有找到匹配的供应商
          </div>
        </div>
      </div>

      <!-- Custom Provider Mode -->
      <div v-if="configMode === 'custom'" class="custom-section">
        <div class="actions">
          <button class="btn btn-primary" @click="startAddCustomProvider">
            + 添加 Provider
          </button>
        </div>

        <!-- Custom Providers List -->
        <div class="providers-list">
          <div v-for="(provider, name) in data.providers" :key="name" class="provider-card">
            <div class="provider-header">
              <h3 class="provider-name">{{ name }}</h3>
              <div class="provider-actions">
                <button
                  class="btn btn-secondary btn-sm"
                  @click="testConnection(name as string)"
                  :disabled="testing[name as string]"
                >
                  {{ testing[name as string] ? '测试中...' : '测试连接' }}
                </button>
                <button class="btn btn-secondary btn-sm" @click="startEditProvider(name as string)">
                  编辑
                </button>
                <button class="btn btn-danger btn-sm" @click="deleteProvider(name as string)">
                  删除
                </button>
              </div>
            </div>

            <div class="provider-info">
              <div class="info-row">
                <span class="info-label">Base URL:</span>
                <span class="info-value">{{ provider.baseUrl }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">API 类型:</span>
                <span class="info-value">{{ provider.api }}</span>
              </div>
              <div class="info-row" v-if="provider.models && provider.models.length > 0">
                <span class="info-label">模型:</span>
                <span class="info-value">{{ getProviderModelsText(provider) }}</span>
              </div>
            </div>

            <span
              v-if="testResults[name as string]"
              :class="['test-result', { success: testResults[name as string].ok, error: !testResults[name as string].ok }]"
            >
              {{ testResults[name as string].message }}
            </span>
          </div>

          <div v-if="Object.keys(data.providers).length === 0" class="empty-state">
            暂无自定义 Provider，点击"添加 Provider"开始配置
          </div>
        </div>
      </div>

      <!-- Add/Edit Provider Dialog -->
      <div v-if="showAddDialog" class="dialog-overlay" @click.self="showAddDialog = false">
        <div class="dialog dialog-large">
          <div class="dialog-header">
            <h3>{{ editingProviderName ? '编辑 Provider' : '添加 Provider' }}</h3>
            <div class="dialog-mode-toggle">
              <button
                :class="['mode-btn', { active: !editJsonMode }]"
                @click="editJsonMode = false"
              >
                表单
              </button>
              <button
                :class="['mode-btn', { active: editJsonMode }]"
                @click="toggleJsonMode"
              >
                JSON
              </button>
            </div>
          </div>

          <!-- Provider Name -->
          <div class="form-group" v-if="!editingProviderName">
            <label>Provider 名称 *</label>
            <input
              v-model="editingProviderName"
              type="text"
              class="form-input"
              placeholder="my-provider"
            />
          </div>
          <div class="form-group" v-else>
            <label>Provider 名称</label>
            <input
              :value="editingProviderName"
              type="text"
              class="form-input"
              disabled
            />
          </div>

          <!-- JSON Mode -->
          <div v-if="editJsonMode" class="json-editor">
            <textarea v-model="editJsonText" class="json-textarea" rows="20"></textarea>
          </div>

          <!-- Form Mode -->
          <div v-else class="form-content">
            <!-- Provider Fields -->
            <div class="form-section">
              <h4>Provider 配置</h4>

              <div class="form-group">
                <label>显示名称</label>
                <input
                  v-model="editingProvider!.name"
                  type="text"
                  class="form-input"
                  placeholder="My Provider"
                />
              </div>

              <div class="form-group">
                <label>API 地址 *</label>
                <input
                  v-model="editingProvider!.baseUrl"
                  type="text"
                  class="form-input"
                  placeholder="https://api.example.com/v1"
                />
              </div>

              <div class="form-group">
                <label>API 密钥 *</label>
                <div class="api-key-input">
                  <input
                    v-model="editingProvider!.apiKey"
                    :type="showApiKeys['editing'] ? 'text' : 'password'"
                    class="form-input"
                    placeholder="sk-..."
                  />
                  <button class="btn-icon" @click="toggleApiKeyVisibility('editing')">
                    {{ showApiKeys['editing'] ? '👁️' : '👁️‍🗨️' }}
                  </button>
                </div>
              </div>

              <div class="form-group">
                <label>接口格式 *</label>
                <select v-model="editingProvider!.api" class="form-select">
                  <option v-for="t in apiTypes" :key="t.value" :value="t.value">
                    {{ t.label }}
                  </option>
                </select>
              </div>
            </div>

            <!-- Models Section -->
            <div class="form-section">
              <div class="section-header">
                <h4>模型配置</h4>
                <button class="btn btn-secondary btn-sm" @click="addModel">+ 添加模型</button>
              </div>

              <div v-if="editingProvider!.models && editingProvider!.models.length > 0" class="models-list">
                <div v-for="(model, index) in editingProvider!.models" :key="index" class="model-item">
                  <div class="model-header">
                    <span class="model-index">模型 {{ index + 1 }}</span>
                    <button class="btn-icon btn-danger-icon" @click="removeModel(index)">🗑️</button>
                  </div>

                  <div class="model-fields">
                    <div class="form-row">
                      <div class="form-group flex-1">
                        <label>模型 ID *</label>
                        <input v-model="model.id" type="text" class="form-input" placeholder="model-id" />
                      </div>
                      <div class="form-group flex-1">
                        <label>显示名称 *</label>
                        <input v-model="model.name" type="text" class="form-input" placeholder="Model Name" />
                      </div>
                    </div>

                    <div class="form-row">
                      <div class="form-group">
                        <label>上下文窗口 *</label>
                        <input v-model.number="model.contextWindow" type="number" class="form-input" placeholder="128000" />
                      </div>
                      <div class="form-group">
                        <label>最大输出 *</label>
                        <input v-model.number="model.maxTokens" type="number" class="form-input" placeholder="4096" />
                      </div>
                    </div>

                    <div class="form-row">
                      <label class="checkbox-label">
                        <input type="checkbox" v-model="model.reasoning" />
                        <span>支持推理</span>
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox" :checked="model.input?.includes('text')" @change="(e: Event) => { const t = e.target as HTMLInputElement; if (t.checked) { if (!model.input) model.input = []; if (!model.input.includes('text')) model.input.push('text'); } else { model.input = model.input?.filter((i: string) => i !== 'text') ?? []; } }" />
                        <span>文本输入</span>
                      </label>
                      <label class="checkbox-label">
                        <input type="checkbox" :checked="model.input?.includes('image')" @change="(e: Event) => { const t = e.target as HTMLInputElement; if (t.checked) { if (!model.input) model.input = []; if (!model.input.includes('image')) model.input.push('image'); } else { model.input = model.input?.filter((i: string) => i !== 'image') ?? []; } }" />
                        <span>图片输入</span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              <div v-else class="empty-hint">暂无模型，点击"添加模型"开始配置</div>
            </div>
          </div>

          <!-- Dialog Actions -->
          <div class="dialog-actions">
            <button class="btn btn-secondary" @click="showAddDialog = false">取消</button>
            <button class="btn btn-primary" @click="editJsonMode ? (editingProvider = JSON.parse(editJsonText), saveCustomProvider()) : saveCustomProvider()" :disabled="saving">
              {{ saving ? '保存中...' : '保存' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.models-config {
  max-width: 900px;
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

.mode-toggle {
  display: flex;
  gap: 24px;
  margin-bottom: 24px;
  padding: 12px 16px;
  background: var(--surface);
  border-radius: 8px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 0.9rem;
}

.section-hint {
  color: var(--text-secondary);
  font-size: 0.85rem;
  margin-bottom: 16px;
}

/* Builtin Mode */
.builtin-top-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 16px;
}

.search-box {
  position: relative;
  flex: 1;
  max-width: 300px;
}

.search-box .form-input {
  padding-left: 36px;
}

.search-icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 0.9rem;
  opacity: 0.5;
}

.builtin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.empty-search {
  grid-column: 1 / -1;
  padding: 32px;
  text-align: center;
  color: var(--text-secondary);
  border: 1px dashed var(--border);
  border-radius: 8px;
}

.builtin-card {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  transition: all 150ms ease;
}

.builtin-card.configured {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.builtin-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.builtin-name {
  font-weight: 600;
  color: var(--text);
}

.status-badge {
  font-size: 0.75rem;
  padding: 2px 8px;
  background: #dcfce7;
  color: #16a34a;
  border-radius: 4px;
}

.builtin-api {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.builtin-key {
  display: flex;
  gap: 8px;
}

.builtin-key .form-input {
  flex: 1;
}

/* Custom Mode */
.actions {
  margin-bottom: 16px;
}

.providers-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.provider-card {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}

.provider-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.provider-name {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}

.provider-actions {
  display: flex;
  gap: 8px;
}

.provider-info {
  font-size: 0.85rem;
}

.info-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}

.info-label {
  color: var(--text-secondary);
}

.info-value {
  color: var(--text);
}

.test-result {
  display: block;
  margin-top: 8px;
  font-size: 0.85rem;
}

.test-result.success {
  color: #10b981;
}

.test-result.error {
  color: #ef4444;
}

.empty-state {
  padding: 40px;
  text-align: center;
  color: var(--text-secondary);
  border: 1px dashed var(--border);
  border-radius: 8px;
}

/* Dialog */
.dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--bg);
  border-radius: 12px;
  padding: 24px;
  width: 500px;
  max-width: 90vw;
  max-height: 90vh;
  overflow-y: auto;
}

.dialog-large {
  width: 700px;
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.dialog-header h3 {
  margin: 0;
  font-size: 1.1rem;
  color: var(--text);
}

.dialog-mode-toggle {
  display: flex;
  gap: 4px;
  padding: 2px;
  background: var(--surface);
  border-radius: 6px;
}

.mode-btn {
  padding: 6px 12px;
  border: none;
  background: transparent;
  font-size: 0.85rem;
  border-radius: 4px;
  cursor: pointer;
  color: var(--text-secondary);
}

.mode-btn.active {
  background: var(--accent);
  color: white;
}

.form-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.form-section {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.form-section h4 {
  margin: 0 0 16px 0;
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text);
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.section-header h4 {
  margin: 0;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.form-input, .form-select {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 0.9rem;
  background: var(--bg);
  color: var(--text);
}

.form-input:focus, .form-select:focus {
  outline: none;
  border-color: var(--accent);
}

.form-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.api-key-input {
  display: flex;
  gap: 8px;
}

.api-key-input .form-input {
  flex: 1;
}

.form-row {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}

.form-row:last-child {
  margin-bottom: 0;
}

.flex-1 {
  flex: 1;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 0.85rem;
}

.models-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.model-item {
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
}

.model-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.model-index {
  font-weight: 500;
  color: var(--text);
}

.model-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.empty-hint {
  color: var(--text-secondary);
  font-size: 0.85rem;
  text-align: center;
  padding: 20px;
}

.json-editor {
  margin-bottom: 16px;
}

.json-textarea {
  width: 100%;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-family: monospace;
  font-size: 0.85rem;
  line-height: 1.5;
  background: var(--surface);
  color: var(--text);
  resize: vertical;
}

.json-textarea:focus {
  outline: none;
  border-color: var(--accent);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 24px;
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

.btn-danger {
  background: #fee2e2;
  color: #dc2626;
}

.btn-sm {
  padding: 6px 12px;
  font-size: 0.8rem;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-icon {
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 4px;
  opacity: 0.6;
}

.btn-icon:hover {
  opacity: 1;
}

.btn-danger-icon {
  color: #dc2626;
}
</style>
