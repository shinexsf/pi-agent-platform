<script setup lang="ts">
/**
 * SkillsConfig — Skills 管理
 *
 * 功能：
 * - 查看 skill 列表
 * - 查看/编辑 skill 内容
 * - 新建 skill
 * - 删除 skill
 * - 导入 skill 文件
 */
import { ref, onMounted } from 'vue';

interface SkillInfo {
  name: string;
  filePath: string;
  baseDir: string;
  hasFrontmatter: boolean;
}

const skills = ref<SkillInfo[]>([]);
const loading = ref(true);
const selectedSkill = ref<string | null>(null);
const skillContent = ref('');
const editing = ref(false);
const saving = ref(false);

// New skill dialog
const showNewDialog = ref(false);
const newSkill = ref({ name: '', content: '' });

// Import dialog
const showImportDialog = ref(false);
const importFile = ref<File | null>(null);

onMounted(async () => {
  await loadSkills();
});

async function loadSkills() {
  loading.value = true;
  try {
    const res = await fetch('/api/config/skills');
    skills.value = await res.json();
  } catch (err) {
    console.error('Failed to load skills:', err);
  } finally {
    loading.value = false;
  }
}

async function selectSkill(skill: SkillInfo) {
  selectedSkill.value = skill.name;
  editing.value = false;
  try {
    const res = await fetch(`/api/config/skills/${skill.name}`);
    const data = await res.json();
    skillContent.value = data.content;
  } catch (err) {
    alert('加载 skill 内容失败');
  }
}

async function saveSkill() {
  if (!selectedSkill.value) return;

  saving.value = true;
  try {
    await fetch(`/api/config/skills/${selectedSkill.value}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: skillContent.value }),
    });
    editing.value = false;
    alert('保存成功');
  } catch (err) {
    alert('保存失败: ' + (err as Error).message);
  } finally {
    saving.value = false;
  }
}

async function createSkill() {
  if (!newSkill.value.name) {
    alert('请输入 skill 名称');
    return;
  }

  try {
    const res = await fetch('/api/config/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: newSkill.value.name,
        content: newSkill.value.content || `# ${newSkill.value.name}\n\nDescribe your skill here.\n`,
      }),
    });

    if (res.ok) {
      showNewDialog.value = false;
      newSkill.value = { name: '', content: '' };
      await loadSkills();
    } else {
      const data = await res.json();
      alert(data.error || '创建失败');
    }
  } catch (err) {
    alert('创建失败: ' + (err as Error).message);
  }
}

async function deleteSkill(name: string) {
  if (!confirm(`确定要删除 skill "${name}" 吗？`)) return;

  try {
    await fetch(`/api/config/skills/${name}`, { method: 'DELETE' });
    if (selectedSkill.value === name) {
      selectedSkill.value = null;
      skillContent.value = '';
    }
    await loadSkills();
  } catch (err) {
    alert('删除失败: ' + (err as Error).message);
  }
}

async function importSkill() {
  if (!importFile.value) return;

  const formData = new FormData();
  formData.append('file', importFile.value as File);

  try {
    const res = await fetch('/api/config/skills/upload', {
      method: 'POST',
      body: formData,
    });

    if (res.ok) {
      showImportDialog.value = false;
      importFile.value = null;
      await loadSkills();
    } else {
      const data = await res.json();
      alert(data.error || '导入失败');
    }
  } catch (err) {
    alert('导入失败: ' + (err as Error).message);
  }
}

function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) {
    importFile.value = file;
  }
}
</script>

<template>
  <div class="skills-config">
    <h2 class="page-title">Skills 管理</h2>

    <div class="actions">
      <button class="btn btn-primary" @click="showNewDialog = true">+ 新建 Skill</button>
      <button class="btn btn-secondary" @click="showImportDialog = true">导入文件</button>
    </div>

    <div class="skills-layout">
      <!-- Skills List -->
      <div class="skills-list-panel">
        <div v-if="loading" class="loading">加载中...</div>
        <div v-else-if="skills.length === 0" class="empty-state">暂无 Skills</div>
        <div v-else class="skills-list">
          <div
            v-for="skill in skills"
            :key="skill.name"
            :class="['skill-item', { active: selectedSkill === skill.name }]"
            @click="selectSkill(skill)"
          >
            <span class="skill-name">{{ skill.name }}</span>
            <button class="btn-icon" @click.stop="deleteSkill(skill.name)" title="删除">🗑️</button>
          </div>
        </div>
      </div>

      <!-- Skill Content -->
      <div class="skill-content-panel">
        <div v-if="!selectedSkill" class="empty-hint">选择一个 Skill 查看内容</div>
        <div v-else>
          <div class="content-header">
            <h3>{{ selectedSkill }}</h3>
            <div class="content-actions">
              <button v-if="!editing" class="btn btn-secondary btn-sm" @click="editing = true">
                编辑
              </button>
              <template v-else>
                <button class="btn btn-secondary btn-sm" @click="editing = false">取消</button>
                <button class="btn btn-primary btn-sm" @click="saveSkill" :disabled="saving">
                  {{ saving ? '保存中...' : '保存' }}
                </button>
              </template>
            </div>
          </div>
          <textarea
            v-model="skillContent"
            class="content-editor"
            :readonly="!editing"
            placeholder="Skill 内容..."
          ></textarea>
        </div>
      </div>
    </div>

    <!-- New Skill Dialog -->
    <div v-if="showNewDialog" class="dialog-overlay" @click.self="showNewDialog = false">
      <div class="dialog">
        <h3>新建 Skill</h3>
        <div class="form-group">
          <label>名称</label>
          <input v-model="newSkill.name" type="text" class="form-input" placeholder="my-skill" />
        </div>
        <div class="form-group">
          <label>内容（可选）</label>
          <textarea v-model="newSkill.content" class="form-textarea" rows="10" placeholder="# My Skill&#10;&#10;Describe your skill here..."></textarea>
        </div>
        <div class="dialog-actions">
          <button class="btn btn-secondary" @click="showNewDialog = false">取消</button>
          <button class="btn btn-primary" @click="createSkill">创建</button>
        </div>
      </div>
    </div>

    <!-- Import Dialog -->
    <div v-if="showImportDialog" class="dialog-overlay" @click.self="showImportDialog = false">
      <div class="dialog">
        <h3>导入 Skill 文件</h3>
        <div class="form-group">
          <label>选择 .md 文件</label>
          <input type="file" accept=".md" @change="handleFileChange" class="form-input" />
        </div>
        <div class="dialog-actions">
          <button class="btn btn-secondary" @click="showImportDialog = false">取消</button>
          <button class="btn btn-primary" @click="importSkill" :disabled="!importFile">导入</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.skills-config {
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

.skills-layout {
  flex: 1;
  display: flex;
  gap: 16px;
  min-height: 0;
}

.skills-list-panel {
  width: 240px;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.skills-list {
  flex: 1;
  overflow-y: auto;
}

.skill-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 150ms ease;
}

.skill-item:hover {
  background: var(--surface-hover);
}

.skill-item.active {
  background: var(--accent-soft);
}

.skill-name {
  font-size: 0.9rem;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-content-panel {
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
