<script setup lang="ts">
/**
 * ModelsConfig — 模型 API 配置管理
 *
 * 两种模式：
 * 1. 有供应商模式：选择内置 provider + 填 API key
 * 2. 自定义模式：完整配置（表单 + JSON 切换）
 */
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { confirmDelete, toast } from '../../composables/useFeedback';

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
const router = useRouter();
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

// Builtin mode
const selectedBuiltinProvider = ref('');
const builtinApiKey = ref('');

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
    toast('请选择 Provider 并填写 API Key', 'error');
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
    toast('保存成功', 'success');
    await loadData();
  } catch (err) {
    toast('保存失败: ' + (err as Error).message, 'error');
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

// 内容型弹框已改为路由页（spec route-based-modals）
function startAddCustomProvider(): void {
  void router.push('/config/models/new');
}

function startEditProvider(name: string): void {
  void router.push(`/config/models/${encodeURIComponent(name)}/edit`);
}

async function deleteProvider(name: string) {
  const confirmed = await confirmDelete('Provider', name);
  if (!confirmed) return;

  try {
    const providers = { ...data.value.providers };
    delete providers[name];
    await fetch('/api/config/models', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providers }),
    });
    toast(`Provider「${name}」已删除`, 'success');
    await loadData();
  } catch (err) {
    toast('删除失败: ' + (err as Error).message, 'error');
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
    </div>

  </div>
</template>

<style scoped>
.models-config {
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
  gap: 10px;
  margin-bottom: 12px;
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
  /* min(280px, 100%)：320px 视口下也不会横向溢出（spec「无横向溢出」） */
  grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
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
  flex-wrap: wrap;
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

.form-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 0.9rem;
  background: var(--bg);
  color: var(--text);
}

.form-input:focus {
  outline: none;
  border-color: var(--accent);
}

.form-input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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

/* 紧凑断点：供应商搜索/保存堆叠，卡片头折行（spec「无横向溢出」） */
@media (max-width: 767px) {
  .builtin-top-actions {
    align-items: stretch;
    flex-direction: column;
    gap: 10px;
  }

  .builtin-top-actions .btn {
    width: 100%;
  }

  .mode-toggle {
    flex-wrap: wrap;
    gap: 12px;
  }

  .provider-header {
    align-items: flex-start;
    flex-direction: column;
    gap: 6px;
  }

  .provider-actions {
    width: 100%;
  }

  .provider-info .info-row {
    flex-direction: column;
    gap: 2px;
  }
}
</style>
