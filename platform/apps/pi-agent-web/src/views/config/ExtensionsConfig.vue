<script setup lang="ts">
/**
 * ExtensionsConfig — 插件管理
 *
 * 功能：
 * - 查看已安装插件列表
 * - 通过 URL 安装（npm/git）
 * - 上传单文件插件
 * - 上传 zip 包安装
 * - 卸载插件
 */
import { ref, onMounted } from 'vue';

interface ExtensionInfo {
  name: string;
  source: 'npm' | 'git' | 'local' | 'builtin';
  path: string;
  enabled: boolean;
}

const extensions = ref<ExtensionInfo[]>([]);
const loading = ref(true);
const installing = ref(false);
const installUrl = ref('');
const uploadFile = ref<File | null>(null);
const uploadZipFile = ref<File | null>(null);

onMounted(async () => {
  await loadExtensions();
});

async function loadExtensions() {
  loading.value = true;
  try {
    const res = await fetch('/api/config/extensions/detail');
    extensions.value = await res.json();
  } catch (err) {
    console.error('Failed to load extensions:', err);
  } finally {
    loading.value = false;
  }
}

async function installByUrl() {
  if (!installUrl.value) {
    alert('请输入插件 URL');
    return;
  }

  installing.value = true;
  try {
    const res = await fetch('/api/config/extensions/install-by-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: installUrl.value }),
    });

    const data = await res.json();
    if (data.ok) {
      alert('安装成功');
      installUrl.value = '';
      await loadExtensions();
    } else {
      alert('安装失败: ' + data.message);
    }
  } catch (err) {
    alert('安装失败: ' + (err as Error).message);
  } finally {
    installing.value = false;
  }
}

async function uploadSingleFile() {
  if (!uploadFile.value) return;

  const formData = new FormData();
  formData.append('file', uploadFile.value as File);

  installing.value = true;
  try {
    const res = await fetch('/api/config/extensions/upload-single', {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();
    if (data.ok) {
      alert('上传成功');
      uploadFile.value = null;
      await loadExtensions();
    } else {
      alert('上传失败: ' + data.message);
    }
  } catch (err) {
    alert('上传失败: ' + (err as Error).message);
  } finally {
    installing.value = false;
  }
}

async function uploadZipPackage() {
  if (!uploadZipFile.value) return;

  const formData = new FormData();
  formData.append('file', uploadZipFile.value as File);

  installing.value = true;
  try {
    const res = await fetch('/api/config/extensions/upload-zip', {
      method: 'POST',
      body: formData,
    });

    const data = await res.json();
    if (data.ok) {
      alert('安装成功');
      uploadZipFile.value = null;
      await loadExtensions();
    } else {
      alert('安装失败: ' + data.message);
    }
  } catch (err) {
    alert('安装失败: ' + (err as Error).message);
  } finally {
    installing.value = false;
  }
}

async function uninstallExtension(name: string, source: string) {
  if (!confirm(`确定要卸载插件 "${name}" 吗？`)) return;

  installing.value = true;
  try {
    const res = await fetch(`/api/config/extensions/${name}`, {
      method: 'DELETE',
    });

    const data = await res.json();
    if (data.ok) {
      await loadExtensions();
    } else {
      alert('卸载失败: ' + (data.message || data.error));
    }
  } catch (err) {
    alert('卸载失败: ' + (err as Error).message);
  } finally {
    installing.value = false;
  }
}

function handleSingleFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    uploadFile.value = file;
  }
}

function handleZipFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    uploadZipFile.value = file;
  }
}

function getSourceLabel(source: string): string {
  switch (source) {
    case 'npm': return 'npm';
    case 'git': return 'git';
    case 'local': return '本地';
    case 'builtin': return '内置';
    default: return source;
  }
}
</script>

<template>
  <div class="extensions-config">
    <h2 class="page-title">插件管理</h2>

    <!-- Install Section -->
    <div class="install-section">
      <h3>安装插件</h3>

      <!-- URL Install -->
      <div class="install-row">
        <input
          v-model="installUrl"
          type="text"
          class="form-input"
          placeholder="npm:@foo/bar 或 git:github.com/user/repo"
          :disabled="installing"
        />
        <button class="btn btn-primary" @click="installByUrl" :disabled="installing || !installUrl">
          {{ installing ? '安装中...' : '通过 URL 安装' }}
        </button>
      </div>

      <!-- File Upload -->
      <div class="upload-row">
        <div class="upload-group">
          <label class="upload-label">单文件插件 (.ts/.js)</label>
          <div class="upload-input-row">
            <input type="file" accept=".ts,.js" @change="handleSingleFileChange" class="form-input" :disabled="installing" />
            <button class="btn btn-secondary" @click="uploadSingleFile" :disabled="installing || !uploadFile">
              上传
            </button>
          </div>
        </div>

        <div class="upload-group">
          <label class="upload-label">Zip 包</label>
          <div class="upload-input-row">
            <input type="file" accept=".zip" @change="handleZipFileChange" class="form-input" :disabled="installing" />
            <button class="btn btn-secondary" @click="uploadZipPackage" :disabled="installing || !uploadZipFile">
              上传并安装
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Extensions List -->
    <div class="extensions-section">
      <h3>已安装插件</h3>
      <div v-if="loading" class="loading">加载中...</div>
      <div v-else-if="extensions.length === 0" class="empty-state">暂无已安装的插件</div>
      <div v-else class="extensions-list">
        <div v-for="ext in extensions" :key="ext.name" class="extension-item">
          <div class="extension-info">
            <span class="extension-name">{{ ext.name }}</span>
            <span :class="['extension-source', `source-${ext.source}`]">{{ getSourceLabel(ext.source) }}</span>
          </div>
          <button
            v-if="ext.source !== 'builtin'"
            class="btn btn-danger btn-sm"
            @click="uninstallExtension(ext.name, ext.source)"
            :disabled="installing"
          >
            卸载
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.extensions-config {
  max-width: 800px;
}

.page-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 24px;
}

.install-section {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 24px;
}

.install-section h3 {
  margin: 0 0 16px 0;
  font-size: 1rem;
  color: var(--text);
}

.install-row {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.install-row .form-input {
  flex: 1;
}

.upload-row {
  display: flex;
  gap: 24px;
}

.upload-group {
  flex: 1;
}

.upload-label {
  display: block;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.upload-input-row {
  display: flex;
  gap: 8px;
}

.upload-input-row .form-input {
  flex: 1;
}

.extensions-section h3 {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 12px;
}

.extensions-list {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.extension-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}

.extension-item:last-child {
  border-bottom: none;
}

.extension-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.extension-name {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--text);
}

.extension-source {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--surface-hover);
  color: var(--text-secondary);
}

.source-npm {
  background: #dbeafe;
  color: #1d4ed8;
}

.source-git {
  background: #dcfce7;
  color: #16a34a;
}

.source-local {
  background: #fef3c7;
  color: #d97706;
}

.source-builtin {
  background: #e5e7eb;
  color: #6b7280;
}

.loading, .empty-state {
  color: var(--text-secondary);
  padding: 40px;
  text-align: center;
}

.form-input {
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
</style>
