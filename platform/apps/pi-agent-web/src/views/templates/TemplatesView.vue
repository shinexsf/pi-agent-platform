<script setup lang="ts">
/**
 * TemplatesView — Agent 模板管理（agent-templates）。
 *
 * 模板是七个 AgentConfig 字段的快照（不含 systemPrompt / 名称 / 模型 / 工作区）。
 * 本页负责新增、编辑（名称 + 描述 + 七项配置快照）、删除；填充在 agent / session 编辑页。
 */
import { computed, onMounted, ref } from 'vue';
import type { AgentTemplateDTO } from '@pi-agent-platform/shared-types';
import AppIcon from '../../components/ui/AppIcon.vue';
import InfoTip from '../../components/ui/InfoTip.vue';
import { confirmDelete, toast } from '../../composables/useFeedback';
import TemplateResourceForm from '../../components/templates/TemplateResourceForm.vue';
import {
  createTemplate,
  fetchTemplates,
  templateFacets,
  templateSnapshot,
  type TemplateTargetConfig,
} from '../../composables/useTemplates';
import { BASE_AGENT_CONFIG } from '../../constants/builtin-tools';

const TEMPLATES_HINT =
  '模板保存「工具 / MCP / Server 工具 / 插件 / Skill / Prompt / 能力授权」七项配置快照（不含 systemPrompt、名称、模型、工作区）。' +
  '在 agent / 会话编辑页点「从模板填充」使用；「存为模板」可把当前配置存成模板。';

const templates = ref<AgentTemplateDTO[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const saving = ref(false);

/** 正在编辑的模板 id（卡片原地展开为编辑器）。 */
const editingId = ref<string | null>(null);
const editName = ref('');
const editDescription = ref('');
const editConfig = ref<TemplateTargetConfig | null>(null);

/** 新增模板（页顶展开的编辑器卡片）。 */
const creating = ref(false);
const createName = ref('');
const createDescription = ref('');
const createConfig = ref<TemplateTargetConfig | null>(null);

function emptyTarget(): TemplateTargetConfig {
  return {
    builtinTools: [...BASE_AGENT_CONFIG.builtinTools],
    mcp: {
      enabled: BASE_AGENT_CONFIG.mcp.enabled === true,
      servers: [...BASE_AGENT_CONFIG.mcp.servers],
    },
    serverBuiltinTools: [...BASE_AGENT_CONFIG.serverBuiltinTools],
    capabilities: null,
    extensions: [...BASE_AGENT_CONFIG.extensions],
    skills: [...BASE_AGENT_CONFIG.skills],
    prompts: [...BASE_AGENT_CONFIG.prompts],
  };
}

function toTarget(t: AgentTemplateDTO): TemplateTargetConfig {
  return {
    builtinTools: [...(t.config.builtinTools ?? [])],
    mcp: {
      enabled: t.config.mcp?.enabled === true,
      servers: [...(t.config.mcp?.servers ?? [])],
    },
    serverBuiltinTools: [...(t.config.serverBuiltinTools ?? [])],
    capabilities:
      t.config.capabilities === null || t.config.capabilities === undefined
        ? null
        : [...t.config.capabilities],
    extensions: [...(t.config.extensions ?? [])],
    skills: [...(t.config.skills ?? [])],
    prompts: [...(t.config.prompts ?? [])],
  };
}

const sorted = computed(() =>
  [...templates.value].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
);

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    templates.value = await fetchTemplates();
  } catch {
    loadError.value = '无法加载模板列表，请检查服务连接。';
  } finally {
    loading.value = false;
  }
}

// ---- 新增 ----
function startCreate(): void {
  creating.value = true;
  editingId.value = null;
  editConfig.value = null;
  createName.value = '';
  createDescription.value = '';
  createConfig.value = emptyTarget();
}

function cancelCreate(): void {
  creating.value = false;
  createConfig.value = null;
}

async function submitCreate(): Promise<void> {
  if (saving.value) return;
  const name = createName.value.trim();
  if (!name) {
    toast('请填写模板名', 'warning');
    return;
  }
  if (!createConfig.value) return;
  saving.value = true;
  try {
    await createTemplate({
      name,
      description: createDescription.value.trim() || undefined,
      config: templateSnapshot(createConfig.value),
    });
    toast(`模板「${name}」已创建`, 'success');
    creating.value = false;
    createConfig.value = null;
    await load();
  } catch (err) {
    toast(`创建失败：${(err as Error).message}`, 'error');
  } finally {
    saving.value = false;
  }
}

// ---- 编辑 ----
function startEdit(t: AgentTemplateDTO): void {
  creating.value = false;
  createConfig.value = null;
  editingId.value = t.id;
  editName.value = t.name;
  editDescription.value = t.description ?? '';
  editConfig.value = toTarget(t);
}

function cancelEdit(): void {
  editingId.value = null;
  editConfig.value = null;
}

async function saveEdit(t: AgentTemplateDTO): Promise<void> {
  if (saving.value) return;
  const name = editName.value.trim();
  if (!name) {
    toast('模板名不能为空', 'warning');
    return;
  }
  saving.value = true;
  try {
    const res = await fetch(`/api/templates/${t.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        description: editDescription.value,
        ...(editConfig.value ? { config: templateSnapshot(editConfig.value) } : {}),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    toast('模板已更新', 'success');
    cancelEdit();
    await load();
  } catch (err) {
    toast(`保存失败：${(err as Error).message}`, 'error');
  } finally {
    saving.value = false;
  }
}

async function remove(t: AgentTemplateDTO): Promise<void> {
  const ok = await confirmDelete('模板', t.name);
  if (!ok) return;
  try {
    const res = await fetch(`/api/templates/${t.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (editingId.value === t.id) cancelEdit();
    toast(`模板「${t.name}」已删除`, 'success');
    await load();
  } catch (err) {
    toast(`删除失败：${(err as Error).message}`, 'error');
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

onMounted(load);
</script>

<template>
  <section class="page-shell" aria-labelledby="templates-title">
    <div class="surface-panel" :aria-busy="loading">
      <div class="panel-toolbar">
        <div class="panel-toolbar-group">
          <h2 id="templates-title" class="panel-title">Agent模板</h2>
          <InfoTip :text="TEMPLATES_HINT" :width="360" />
        </div>
        <div class="panel-toolbar-group toolbar-meta">
          <span class="page-count">{{ templates.length }} 个模板</span>
          <button class="btn btn-icon" type="button" title="刷新" aria-label="刷新" @click="load">
            <AppIcon name="refresh" :size="16" />
          </button>
          <button class="btn btn-primary" type="button" :disabled="creating" @click="startCreate">
            <AppIcon name="plus" :size="15" />
            <span>新增模板</span>
          </button>
        </div>
      </div>

      <!-- 新增模板（编辑器卡片） -->
      <div v-if="creating && createConfig" class="tpl-editor tpl-create">
        <div class="tpl-editor-head">
          <span class="tpl-editor-title">新增模板</span>
          <InfoTip text="模板是一份七字段快照（不含 systemPrompt）。这里只是编辑模板本身，不会改动任何 agent / 会话。" :width="320" />
        </div>
        <div class="tpl-editor-fields">
          <label class="tpl-field">
            <span class="tpl-field-label">名称</span>
            <input v-model="createName" class="control" placeholder="例如：前端重构" />
          </label>
          <label class="tpl-field">
            <span class="tpl-field-label">描述</span>
            <input v-model="createDescription" class="control" placeholder="用途说明（可选）" />
          </label>
        </div>
        <TemplateResourceForm :model-value="createConfig" />
        <div class="tpl-editor-actions">
          <button class="btn btn-primary" type="button" :disabled="saving" @click="submitCreate">创建</button>
          <button class="btn" type="button" @click="cancelCreate">取消</button>
        </div>
      </div>

      <div v-if="loadError" class="empty-state">{{ loadError }}</div>
      <div v-else-if="loading" class="empty-state">加载中…</div>
      <div v-else-if="templates.length === 0 && !creating" class="empty-state">
        还没有模板。点右上角「新增模板」从零勾选，或打开 agent 编辑页在 Resources 里点「存为模板」。
      </div>

      <div v-else class="tpl-grid">
        <template v-for="t in sorted" :key="t.id">
          <!-- 编辑态：占满整行的编辑器卡片 -->
          <div v-if="editingId === t.id" class="tpl-editor">
            <div class="tpl-editor-head">
              <span class="tpl-editor-title">编辑模板</span>
              <InfoTip text="模板是一份七字段快照（不含 systemPrompt）。填充到 agent / 会话后若不保存，退出编辑即恢复原值。" :width="320" />
            </div>
            <div class="tpl-editor-fields">
              <label class="tpl-field">
                <span class="tpl-field-label">名称</span>
                <input v-model="editName" class="control" placeholder="模板名（必填）" />
              </label>
              <label class="tpl-field">
                <span class="tpl-field-label">描述</span>
                <input v-model="editDescription" class="control" placeholder="用途说明（可选）" />
              </label>
            </div>
            <TemplateResourceForm v-if="editConfig" :model-value="editConfig" />
            <div class="tpl-editor-actions">
              <button class="btn btn-primary" type="button" :disabled="saving" @click="saveEdit(t)">保存</button>
              <button class="btn" type="button" @click="cancelEdit">取消</button>
              <button class="btn btn-danger tpl-editor-remove" type="button" @click="remove(t)">删除</button>
            </div>
          </div>

          <!-- 展示态：卡片 -->
          <article v-else class="tpl-card">
            <header class="tpl-card-head">
              <h3 class="tpl-card-name" :title="t.name">{{ t.name }}</h3>
              <span class="tpl-card-time">{{ formatTime(t.updatedAt) }}</span>
            </header>
            <p v-if="t.description" class="tpl-card-desc">{{ t.description }}</p>
            <p v-else class="tpl-card-desc is-empty">无描述</p>
            <div class="tpl-card-facets">
              <span
                v-for="facet in templateFacets(t.config)"
                :key="facet.key"
                class="tpl-facet"
                :class="'is-' + facet.tone"
              >{{ facet.value }}</span>
            </div>
            <footer class="tpl-card-actions">
              <button class="btn" type="button" @click="startEdit(t)">
                <AppIcon name="edit" :size="14" />
                <span>编辑</span>
              </button>
              <button class="btn btn-danger" type="button" @click="remove(t)">
                <AppIcon name="trash" :size="14" />
                <span>删除</span>
              </button>
            </footer>
          </article>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.tpl-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

@media (max-width: 640px) {
  .tpl-grid {
    grid-template-columns: 1fr;
  }
}

.tpl-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg, 12px);
  background: var(--surface-raised, rgba(255, 255, 255, 0.025));
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.tpl-card:hover {
  border-color: var(--border-strong, var(--border-subtle));
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.tpl-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.tpl-card-name {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tpl-card-time {
  flex-shrink: 0;
  font-size: 0.7rem;
  color: var(--text-tertiary, var(--text-secondary));
  opacity: 0.7;
}

.tpl-card-desc {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.5;
  color: var(--text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tpl-card-desc.is-empty {
  opacity: 0.45;
}

.tpl-card-facets {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.tpl-facet {
  padding: 2px 7px;
  border-radius: 999px;
  border: 1px solid var(--border-subtle);
  font-size: 0.7rem;
  font-family: var(--font-mono, ui-monospace, monospace);
  white-space: nowrap;
}

.tpl-facet.is-on {
  color: var(--text);
  border-color: var(--border-strong, var(--border-subtle));
  background: rgba(99, 132, 255, 0.1);
}

.tpl-facet.is-off {
  color: var(--text-tertiary, var(--text-secondary));
  opacity: 0.6;
}

.tpl-card-actions {
  display: flex;
  gap: 8px;
  margin-top: auto;
  padding-top: 6px;
  border-top: 1px solid var(--border-subtle);
}

.tpl-card-actions .btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.tpl-editor {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border-strong, var(--border-subtle));
  border-radius: var(--radius-lg, 12px);
  background: var(--surface-raised, rgba(255, 255, 255, 0.03));
}

.tpl-create {
  margin-bottom: 14px;
  border-style: dashed;
}

.tpl-editor-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.tpl-editor-title {
  font-size: 0.9rem;
  font-weight: 600;
}

.tpl-editor-sub {
  font-size: 0.72rem;
  color: var(--text-tertiary, var(--text-secondary));
}

.tpl-editor-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.tpl-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1 1 200px;
  min-width: 0;
}

.tpl-field-label {
  font-size: 0.72rem;
  color: var(--text-secondary);
}

.tpl-editor-actions {
  display: flex;
  gap: 8px;
}

.tpl-editor-remove {
  margin-left: auto;
}

.empty-state {
  padding: 32px 12px;
  text-align: center;
  font-size: 0.85rem;
  color: var(--text-secondary);
}
</style>
