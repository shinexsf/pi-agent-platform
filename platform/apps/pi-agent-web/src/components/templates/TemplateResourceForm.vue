<script setup lang="ts">
/**
 * TemplateResourceForm — 模板编辑器里的资源配置表单（七个字段中的六项 + 能力授权）。
 *
 * 与 agent / session 编辑页同源：
 * - 清单来自 `constants/builtin-tools.ts`
 * - 失效项判定来自 `useConfigIssues()`（同一个 `findConfigIssues` 规则表），只标黄不阻断保存
 * - 样式复用 agent 编辑页的 `.resource-*` / `.tag-*` 类名，保证三处观感一致
 */
import { computed, onMounted, ref, watch } from 'vue';
import InfoTip from '../ui/InfoTip.vue';
import McpSelectionGroup from '../config/McpSelectionGroup.vue';
import {
  BUILTIN_TOOL_NAMES,
  withMcpDependencies,
} from '../../constants/builtin-tools';
import { useConfigIssues } from '../../composables/useConfigIssues';
import { useMcpCatalog } from '../../composables/useMcpCatalog';
import type { TemplateTargetConfig } from '../../composables/useTemplates';

const props = defineProps<{ modelValue: TemplateTargetConfig }>();

const issues = useConfigIssues();

const availableSkills = computed(() => issues.available.value.skills ?? []);
const availablePrompts = computed(() => issues.available.value.prompts ?? []);
const availableExtensions = computed(() => issues.available.value.extensions ?? []);
/** 平台插件候选（有会话内能力的那些）。 */
const availablePlugins = computed(() => issues.available.value.plugins ?? []);
const has = computed(() => issues.buildIssueIndex(props.modelValue, null));

/** 模板里引用了但环境里不存在的项。 */
const staleIssues = computed(() => issues.issuesFor(props.modelValue, null));

/** 平台 MCP 目录（server 定义只在 `~/.pi/server/mcp.json`）。 */
const {
  servers: mcpCatalog,
  errors: mcpCatalogErrors,
  conflicts: mcpConflicts,
  loading: mcpCatalogLoading,
  load: loadMcpCatalog,
} = useMcpCatalog();

function setMcpEnabled(next: boolean): void {
  props.modelValue.mcp = { enabled: next, servers: [...props.modelValue.mcp.servers] };
  if (next) props.modelValue.builtinTools = withMcpDependencies(props.modelValue.builtinTools);
}

function setMcpServers(next: string[]): void {
  props.modelValue.mcp = { enabled: props.modelValue.mcp.enabled, servers: [...next] };
}

/** 勾选/取消一个「字符串数组」字段里的值 */
function toggleValue(
  field: 'builtinTools' | 'extensions' | 'plugins' | 'skills' | 'prompts',
  value: string,
  checked: boolean,
): void {
  const current = props.modelValue[field];
  props.modelValue[field] = checked
    ? (current.includes(value) ? current : [...current, value])
    : current.filter((v) => v !== value);
}

function pruneField(
  field:
    | 'builtinTools'
    | 'extensions'
    | 'plugins'
    | 'skills'
    | 'prompts',
): void {
  const current = props.modelValue[field] ?? [];
  props.modelValue[field] = issues.pruneInvalid(field, current);
}

onMounted(async () => {
  void loadMcpCatalog();
  await issues.loadAvailability();
});
</script>

<template>
  <div class="resources-body">
    <div v-if="staleIssues.length" class="issues-banner">
      <span class="issues-banner-title">模板里引用了当前环境中不存在的资源（仍可保存）</span>
      <div class="issues-banner-list">
        <span v-for="issue in staleIssues" :key="issue.field + issue.value">
          {{ issue.field }} · {{ issue.value }}
        </span>
      </div>
    </div>

    <!-- Builtin tools -->
    <div class="resource-group">
      <div class="resource-group-header">
        <span class="resource-group-title">Builtin tools</span>
        <InfoTip text="pi 的核心工具 + codemode / tool_search 内置扩展。勾选即装载；MCP 见下方独立开关。" :width="320" />
        <span class="resource-group-count">{{ props.modelValue.builtinTools.length }} / {{ BUILTIN_TOOL_NAMES.length }}</span>
        <span class="resource-edit-actions">
          <button type="button" class="btn-link" @click="props.modelValue.builtinTools = [...BUILTIN_TOOL_NAMES]">全选</button>
          <button type="button" class="btn-link" @click="props.modelValue.builtinTools = []">清空</button>
          <button type="button" class="btn-link" @click="pruneField('builtinTools')">清理无效项</button>
        </span>
      </div>
      <div class="tag-list editable">
        <label v-for="t in BUILTIN_TOOL_NAMES" :key="t" class="tag-check"
          :class="{ checked: props.modelValue.builtinTools.includes(t) }">
          <input type="checkbox" :checked="props.modelValue.builtinTools.includes(t)"
            @change="toggleValue('builtinTools', t, ($event.target as HTMLInputElement).checked)" />
          <span>{{ t }}</span>
        </label>
        <label v-for="t in props.modelValue.builtinTools.filter(x => !BUILTIN_TOOL_NAMES.includes(x as never))" :key="'g-' + t"
          class="tag-check checked tag-invalid" title="工具不存在">
          <input type="checkbox" :checked="true" @change="toggleValue('builtinTools', t, false)" />
          <span>{{ t }}（无效）</span>
        </label>
      </div>
    </div>

    <!-- MCP：总开关 + 平台目录 server 勾选 -->
    <McpSelectionGroup
      :enabled="props.modelValue.mcp.enabled"
      :servers="props.modelValue.mcp.servers"
      :catalog="mcpCatalog"
      :errors="mcpCatalogErrors"
      :conflicts="mcpConflicts"
      :loading="mcpCatalogLoading"
      @update:enabled="setMcpEnabled"
      @update:servers="setMcpServers"
    />


    <!-- 平台插件（会话内能力来源） -->
    <div class="resource-group">
      <div class="resource-group-header">
        <span class="resource-group-title">Platform Plugins</span>
        <InfoTip text="模板里记录的平台插件启用列表。启用 → 该 agent 的会话会装载插件的 pi 扩展工具、worker 方法与自带 skill。" :width="340" />
        <span class="resource-group-count">{{ props.modelValue.plugins.length }} / {{ availablePlugins.length }}</span>
        <span class="resource-edit-actions">
          <button type="button" class="btn-link" @click="props.modelValue.plugins = [...availablePlugins]">全选</button>
          <button type="button" class="btn-link" @click="props.modelValue.plugins = []">清空</button>
          <button type="button" class="btn-link" @click="pruneField('plugins')">清理无效项</button>
        </span>
      </div>
      <div class="tag-list editable">
        <label v-for="id in availablePlugins" :key="id" class="tag-check"
          :class="{ checked: props.modelValue.plugins.includes(id), 'tag-invalid': has('plugins', id) }">
          <input type="checkbox" :checked="props.modelValue.plugins.includes(id)"
            @change="toggleValue('plugins', id, ($event.target as HTMLInputElement).checked)" />
          <span>{{ id }}</span>
        </label>
        <label v-for="id in props.modelValue.plugins.filter(x => has('plugins', x))" :key="'g-' + id"
          class="tag-check checked tag-invalid" title="平台插件不存在或未安装">
          <input type="checkbox" :checked="true" @change="toggleValue('plugins', id, false)" />
          <span>{{ id }}（无效）</span>
        </label>
        <span v-if="availablePlugins.length === 0" class="resource-empty">没有可启用的平台插件</span>
      </div>
    </div>

    <!-- Extensions -->
    <div class="resource-group">
      <div class="resource-group-header">
        <span class="resource-group-title">Extensions</span>
        <span class="resource-group-count">{{ props.modelValue.extensions.length }} / {{ availableExtensions.length }}</span>
        <span class="resource-edit-actions">
          <button type="button" class="btn-link" @click="props.modelValue.extensions = [...availableExtensions]">全选</button>
          <button type="button" class="btn-link" @click="props.modelValue.extensions = []">清空</button>
          <button type="button" class="btn-link" @click="pruneField('extensions')">清理无效项</button>
        </span>
      </div>
      <div class="tag-list editable">
        <label v-for="e in availableExtensions" :key="e" class="tag-check"
          :class="{ checked: props.modelValue.extensions.includes(e), 'tag-invalid': has('extensions', e) }">
          <input type="checkbox" :checked="props.modelValue.extensions.includes(e)"
            @change="toggleValue('extensions', e, ($event.target as HTMLInputElement).checked)" />
          <span>{{ e }}</span>
        </label>
        <label v-for="e in props.modelValue.extensions.filter(x => has('extensions', x))" :key="'g-' + e"
          class="tag-check checked tag-invalid" title="插件不存在或未安装">
          <input type="checkbox" :checked="true" @change="toggleValue('extensions', e, false)" />
          <span>{{ e }}（无效）</span>
        </label>
        <span v-if="availableExtensions.length === 0" class="resource-empty">未安装插件</span>
      </div>
    </div>

    <!-- Skills -->
    <div class="resource-group">
      <div class="resource-group-header">
        <span class="resource-group-title">Skills</span>
        <span class="resource-group-count">{{ props.modelValue.skills.length }} / {{ availableSkills.length }}</span>
        <span class="resource-edit-actions">
          <button type="button" class="btn-link" @click="props.modelValue.skills = [...availableSkills]">全选</button>
          <button type="button" class="btn-link" @click="props.modelValue.skills = []">清空</button>
          <button type="button" class="btn-link" @click="pruneField('skills')">清理无效项</button>
        </span>
      </div>
      <div class="tag-list editable">
        <label v-for="s in availableSkills" :key="s" class="tag-check"
          :class="{ checked: props.modelValue.skills.includes(s), 'tag-invalid': has('skills', s) }">
          <input type="checkbox" :checked="props.modelValue.skills.includes(s)"
            @change="toggleValue('skills', s, ($event.target as HTMLInputElement).checked)" />
          <span>{{ s }}</span>
        </label>
        <label v-for="s in props.modelValue.skills.filter(x => has('skills', x))" :key="'g-' + s"
          class="tag-check checked tag-invalid" title="Skill 不存在">
          <input type="checkbox" :checked="true" @change="toggleValue('skills', s, false)" />
          <span>{{ s }}（无效）</span>
        </label>
        <span v-if="availableSkills.length === 0" class="resource-empty">未安装 Skill</span>
      </div>
    </div>

    <!-- Prompts -->
    <div class="resource-group">
      <div class="resource-group-header">
        <span class="resource-group-title">Prompts</span>
        <span class="resource-group-count">{{ props.modelValue.prompts.length }} / {{ availablePrompts.length }}</span>
        <span class="resource-edit-actions">
          <button type="button" class="btn-link" @click="props.modelValue.prompts = [...availablePrompts]">全选</button>
          <button type="button" class="btn-link" @click="props.modelValue.prompts = []">清空</button>
          <button type="button" class="btn-link" @click="pruneField('prompts')">清理无效项</button>
        </span>
      </div>
      <div class="tag-list editable">
        <label v-for="p in availablePrompts" :key="p" class="tag-check"
          :class="{ checked: props.modelValue.prompts.includes(p), 'tag-invalid': has('prompts', p) }">
          <input type="checkbox" :checked="props.modelValue.prompts.includes(p)"
            @change="toggleValue('prompts', p, ($event.target as HTMLInputElement).checked)" />
          <span>{{ p }}</span>
        </label>
        <label v-for="p in props.modelValue.prompts.filter(x => has('prompts', x))" :key="'g-' + p"
          class="tag-check checked tag-invalid" title="Prompt 不存在">
          <input type="checkbox" :checked="true" @change="toggleValue('prompts', p, false)" />
          <span>{{ p }}（无效）</span>
        </label>
        <span v-if="availablePrompts.length === 0" class="resource-empty">未安装 Prompt</span>
      </div>
    </div>

  </div>
</template>

<style scoped>
/* 与 AgentEditorView / SessionDetailView 的资源配置区保持一致（同一套类名与取值） */
.resources-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.resource-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.resource-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.resource-group-title {
  font-size: 0.82rem;
  font-weight: 650;
  color: var(--text);
}

.resource-group-count {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

.resource-empty {
  font-size: 0.78rem;
  color: var(--text-tertiary);
  font-style: italic;
}

.resource-module {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  opacity: 0.65;
  margin: 6px 0 4px;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tag-check {
  display: inline-flex;
  align-items: center;
  height: 26px;
  padding: 0 8px;
  font-size: 0.72rem;
  font-weight: 550;
  color: var(--text-secondary);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  transition: all 120ms;
  user-select: none;
}

.tag-check input {
  display: none;
}

.tag-check.checked {
  color: var(--accent-ink);
  background: var(--accent-soft);
  border-color: var(--accent);
}

.tag-check:not(.checked):hover {
  border-color: var(--border-strong);
}

.tag-check em {
  font-style: normal;
  opacity: 0.55;
  margin-left: 4px;
}

.tag-invalid,
.tag-check.tag-invalid {
  border-color: #d97706 !important;
  color: #b45309 !important;
  background: rgba(245, 158, 11, 0.12) !important;
}

.checkbox-inline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.78rem;
  color: var(--text-secondary);
  cursor: pointer;
}

.resource-edit-actions {
  display: flex;
  gap: 12px;
}

.btn-link {
  border: 0;
  background: none;
  color: var(--accent);
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}

.btn-link:hover {
  text-decoration: underline;
}

.issues-banner {
  border: 1px solid rgba(245, 158, 11, 0.45);
  background: rgba(245, 158, 11, 0.1);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.6;
}

.issues-banner-title {
  font-weight: 600;
  color: #b45309;
}

.issues-banner-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
  color: var(--text-secondary);
}
</style>
