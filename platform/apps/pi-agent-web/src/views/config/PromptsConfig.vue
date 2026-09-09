<script setup lang="ts">
/**
 * PromptsConfig — Prompts 管理
 *
 * 功能：
 * - 查看 prompt 列表
 * - 查看/编辑 prompt 内容
 * - 新建 prompt
 * - 删除 prompt
 */
import { ref, onMounted } from 'vue';

interface PromptInfo {
  name: string;
  filePath: string;
  baseDir: string;
  hasFrontmatter: boolean;
}

const prompts = ref<PromptInfo[]>([]);
const loading = ref(true);
const selectedPrompt = ref<string | null>(null);
const promptContent = ref('');
const editing = ref(false);
const saving = ref(false);

// New prompt dialog
const showNewDialog = ref(false);
const newPrompt = ref({ name: '', content: '' });

onMounted(async () => {
  await loadPrompts();
});

async function loadPrompts() {
  loading.value = true;
  try {
    const res = await fetch('/api/config/prompts');
    prompts.value = await res.json();
  } catch (err) {
    console.error('Failed to load prompts:', err);
  } finally {
    loading.value = false;
  }
}

async function selectPrompt(prompt: PromptInfo) {
  selectedPrompt.value = prompt.name;
  editing.value = false;
  try {
    const res = await fetch(`/api/config/prompts/${prompt.name}`);
    const data = await res.json();
    promptContent.value = data.content;
  } catch (err) {
    alert('加载 prompt 内容失败');
  }
}

async function savePrompt() {
  if (!selectedPrompt.value) return;

  saving.value = true;
  try {
    await fetch(`/api/config/prompts/${selectedPrompt.value}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: promptContent.value }),
    });
    editing.value = false;
    alert('保存成功');
  } catch (err) {
    alert('保存失败: ' + (err as Error).message);
  } finally {
    saving.value = false;
  }
}

async function createPrompt() {
  if (!newPrompt.value.name) {
    alert('请输入 prompt 名称');
    return;
  }

  try {
    const res = await fetch('/api/config/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newPrompt.value.name,
        content: newPrompt.value.content || `# ${newPrompt.value.name}\n\nDescribe your prompt template here.\n`,
      }),
    });

    if (res.ok) {
      showNewDialog.value = false;
      newPrompt.value = { name: '', content: '' };
      await loadPrompts();
    } else {
      const data = await res.json();
      alert(data.error || '创建失败');
    }
  } catch (err) {
    alert('创建失败: ' + (err as Error).message);
  }
}

async function deletePrompt(name: string) {
  if (!confirm(`确定要删除 prompt "${name}" 吗？`)) return;

  try {
    await fetch(`/api/config/prompts/${name}`, { method: 'DELETE' });
    if (selectedPrompt.value === name) {
      selectedPrompt.value = null;
      promptContent.value = '';
    }
    await loadPrompts();
  } catch (err) {
    alert('删除失败: ' + (err as Error).message);
  }
}
</script>

<template>
  <div class="prompts-config">
    <h2 class="page-title">Prompts 管理</h2>

    <div class="actions">
      <button class="btn btn-primary" @click="showNewDialog = true">+ 新建 Prompt</button>
    </div>

    <div class="prompts-layout">
      <!-- Prompts List -->
      <div class="prompts-list-panel">
        <div v-if="loading" class="loading">加载中...</div>
        <div v-else-if="prompts.length === 0" class="empty-state">暂无 Prompts</div>
        <div v-else class="prompts-list">
          <div
            v-for="prompt in prompts"
            :key="prompt.name"
            :class="['prompt-item', { active: selectedPrompt === prompt.name }]"
            @click="selectPrompt(prompt)"
          >
            <span class="prompt-name">{{ prompt.name }}</span>
            <button class="btn-icon" @click.stop="deletePrompt(prompt.name)" title="删除">🗑️</button>
          </div>
        </div>
      </div>

      <!-- Prompt Content -->
      <div class="prompt-content-panel">
        <div v-if="!selectedPrompt" class="empty-hint">选择一个 Prompt 查看内容</div>
        <div v-else>
          <div class="content-header">
            <h3>{{ selectedPrompt }}</h3>
            <div class="content-actions">
              <button v-if="!editing" class="btn btn-secondary btn-sm" @click="editing = true">
                编辑
              </button>
              <template v-else>
                <button class="btn btn-secondary btn-sm" @click="editing = false">取消</button>
                <button class="btn btn-primary btn-sm" @click="savePrompt" :disabled="saving">
                  {{ saving ? '保存中...' : '保存' }}
                </button>
              </template>
            </div>
          </div>
          <textarea
            v-model="promptContent"
            class="content-editor"
            :readonly="!editing"
            placeholder="Prompt 内容..."
          ></textarea>
        </div>
      </div>
    </div>

    <!-- New Prompt Dialog -->
    <div v-if="showNewDialog" class="dialog-overlay" @click.self="showNewDialog = false">
      <div class="dialog">
        <h3>新建 Prompt</h3>
        <div class="form-group">
          <label>名称</label>
          <input v-model="newPrompt.name" type="text" class="form-input" placeholder="my-prompt" />
        </div>
        <div class="form-group">
          <label>内容（可选）</label>
          <textarea v-model="newPrompt.content" class="form-textarea" rows="10" placeholder="# My Prompt&#10;&#10;Describe your prompt template here..."></textarea>
        </div>
        <div class="dialog-actions">
          <button class="btn btn-secondary" @click="showNewDialog = false">取消</button>
          <button class="btn btn-primary" @click="createPrompt">创建</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.prompts-config {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.page-title {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 16px;
}

.actions {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}

.prompts-layout {
  flex: 1;
  display: flex;
  gap: 16px;
  min-height: 0;
}

.prompts-list-panel {
  width: 240px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.prompts-list {
  flex: 1;
  overflow-y: auto;
}

.prompt-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 150ms ease;
}

.prompt-item:hover {
  background: var(--surface-hover);
}

.prompt-item.active {
  background: var(--accent-soft);
}

.prompt-name {
  font-size: 0.9rem;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prompt-content-panel {
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.content-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.content-header h3 {
  margin: 0;
  font-size: 1rem;
  color: var(--text);
}

.content-actions {
  display: flex;
  gap: 8px;
}

.content-editor {
  flex: 1;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 16px;
  border: none;
  resize: none;
  font-family: monospace;
  font-size: 0.9rem;
  line-height: 1.6;
  background: var(--bg);
  color: var(--text);
  white-space: pre-wrap;
  word-wrap: break-word;
  box-sizing: border-box;
}

.content-editor:focus {
  outline: none;
}

.content-editor:read-only {
  background: var(--surface);
}

.loading, .empty-state, .empty-hint {
  color: var(--text-secondary);
  padding: 40px;
  text-align: center;
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

.btn-sm {
  padding: 6px 12px;
  font-size: 0.8rem;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

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
  width: 450px;
  max-width: 90vw;
}

.dialog h3 {
  margin: 0 0 20px 0;
  font-size: 1.1rem;
  color: var(--text);
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

.form-input, .form-textarea {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 0.9rem;
  background: var(--bg);
  color: var(--text);
}

.form-textarea {
  font-family: monospace;
  resize: vertical;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 24px;
}
</style>
