<script setup lang="ts">
/**
 * SessionDetailView — 会话详情路由页（只读查看 + 编辑模式）。
 *
 * 路由：/sessions/:id（查看） / sessions/:id/edit（编辑）
 */
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { SessionDTO, AgentDTO } from '@pi-agent-platform/shared-types';
import EditorPage from '../../components/layout/primitives/EditorPage.vue';
import AppIcon from '../../components/ui/AppIcon.vue';
import { toast } from '../../composables/useFeedback';
import { setCrumbName } from '../../composables/breadcrumbNames';

interface ModelOption { provider: string; modelId: string; displayName: string }

const route = useRoute();
const router = useRouter();

const sessionId = computed(() => {
  const raw = route.params.id;
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v : '';
});

const mode = computed<'view' | 'edit'>(() =>
  route.path.endsWith('/edit') ? 'edit' : 'view'
);
const isView = computed(() => mode.value === 'view');

const loading = ref(true);
const saving = ref(false);
const loadError = ref<string | null>(null);

const session = ref<SessionDTO | null>(null);
const agent = ref<AgentDTO | null>(null);
const allModels = ref<ModelOption[]>([]);

// editable fields
const title = ref('');
const model = ref('');
const thinkingLevel = ref('');
const builtinTools = ref<string[] | null>(null);
const extensions = ref<string[] | null>(null);
const skills = ref<string[] | null>(null);
const prompts = ref<string[] | null>(null);

const thinkingLevels = ['low', 'medium', 'high'];
const BUILTIN_TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
const builtinToolCount = computed(() => BUILTIN_TOOLS.length);

// available resources
const availableSkills = ref<{ name: string }[]>([]);
const availablePrompts = ref<{ name: string }[]>([]);
const availableExtensions = ref<{ names: string[] }>({ names: [] });
const skillNames = computed(() => availableSkills.value.map(i => i.name));
const promptNames = computed(() => availablePrompts.value.map(i => i.name));

// resource section collapsed state
const resourcesExpanded = ref(false);

onMounted(async () => {
  try {
    const [sessionRes, modelsRes, skillsRes, promptsRes, extensionsRes] = await Promise.all([
      fetch(`/api/sessions/${sessionId.value}`),
      fetch('/api/models'),
      fetch('/api/config/skills'),
      fetch('/api/config/prompts'),
      fetch('/api/config/extensions'),
    ]);

    if (!sessionRes.ok) throw new Error(`HTTP ${sessionRes.status}`);
    session.value = (await sessionRes.json()) as SessionDTO;
    if (modelsRes.ok) allModels.value = (await modelsRes.json()) as ModelOption[];
    if (skillsRes.ok) availableSkills.value = (await skillsRes.json()) as { name: string }[];
    if (promptsRes.ok) availablePrompts.value = (await promptsRes.json()) as { name: string }[];
    if (extensionsRes.ok) availableExtensions.value = (await extensionsRes.json()) as { names: string[] };

    // load agent info
    if (session.value.agentId) {
      const agentRes = await fetch(`/api/agents/${session.value.agentId}`);
      if (agentRes.ok) agent.value = (await agentRes.json()) as AgentDTO;
    }

    // populate editable fields
    title.value = session.value.title ?? '';
    model.value = session.value.model;
    thinkingLevel.value = session.value.thinkingLevel ?? '';
    setCrumbName(session.value.id, session.value.title || session.value.id.slice(0, 8));
    builtinTools.value = session.value.config?.builtinTools !== undefined ? [...(session.value.config.builtinTools ?? [])] : null;
    extensions.value = session.value.config?.extensions !== undefined ? [...(session.value.config.extensions ?? [])] : null;
    skills.value = session.value.config?.skills !== undefined ? [...(session.value.config.skills ?? [])] : null;
    prompts.value = session.value.config?.prompts !== undefined ? [...(session.value.config.prompts ?? [])] : null;
  } catch (err) {
    loadError.value = `加载失败：${(err as Error).message}`;
  } finally {
    loading.value = false;
  }
});

async function save(): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    const body: Record<string, unknown> = {};
    if (title.value !== (session.value?.title ?? '')) body.title = title.value || undefined;
    if (model.value !== session.value?.model) body.model = model.value;
    if (thinkingLevel.value !== (session.value?.thinkingLevel ?? '')) body.thinkingLevel = thinkingLevel.value || undefined;
    body.config = {
      ...(session.value?.config ?? {}),
      builtinTools: builtinTools.value,
      extensions: extensions.value,
      skills: skills.value,
      prompts: prompts.value,
    };

    const res = await fetch(`/api/sessions/${sessionId.value}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    toast('会话已更新', 'success');
    router.push(`/sessions/${sessionId.value}`);
  } catch (err) {
    toast(`保存失败：${(err as Error).message}`, 'error');
  } finally {
    saving.value = false;
  }
}

function openChat(): void {
  const base = import.meta.env.BASE_URL || '/';
  const url = `${base}chat/${sessionId.value}${session.value?.agentId ? `?agentId=${session.value.agentId}` : ''}`;
  window.open(url, '_blank');
}

function formatModel(m: string): string {
  const found = allModels.value.find((x) => `${x.provider}/${x.modelId}` === m);
  return found ? `${found.displayName} (${found.provider})` : m;
}

function timeAgo(ts: number): string {
  const d = Math.max(0, Date.now() - ts);
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}小时前`;
  return new Date(ts).toLocaleDateString();
}

function workerUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
</script>

<template>
  <div class="session-detail-wrap">
    <EditorPage
      :title="isView ? (session?.title || sessionId.slice(0, 8)) : `编辑会话`"
      cancel-to="/sessions"
      back-label="Sessions"
      :can-save="isView ? false : true"
      :saving="saving"
      @save="save"
    >
      <template v-if="isView && !loading" #actions>
        <button class="btn btn-primary" type="button" @click="openChat">
          <AppIcon name="sessions" :size="15" />
          <span>打开会话</span>
        </button>
        <button class="btn btn-secondary" type="button" @click="router.push(`/sessions/${sessionId}/edit`)">
          <AppIcon name="edit" :size="15" />
          <span>编辑</span>
        </button>
      </template>

      <div v-if="loading" class="sd-state">加载中...</div>
      <div v-else-if="loadError" class="sd-state">{{ loadError }}</div>

      <div v-else-if="session" class="sd-content">
        <!-- 基本信息 -->
        <div class="sd-section">
          <h3 class="sd-section-title">基本信息</h3>
          <div class="sd-grid">
            <div class="sd-field">
              <span class="sd-label">标题</span>
              <template v-if="isView">
                <div class="sd-readonly">{{ session.title || '—' }}</div>
              </template>
              <template v-else>
                <input v-model="title" class="control" placeholder="输入会话标题" />
              </template>
            </div>

            <div class="sd-field">
              <span class="sd-label">Session ID</span>
              <div class="sd-readonly mono">{{ session.id }}</div>
            </div>

            <div class="sd-field">
              <span class="sd-label">Status</span>
              <div class="sd-readonly">
                <span class="status-badge" :class="session.status === 'active' ? 'is-live' : ''">{{ session.status }}</span>
              </div>
            </div>

            <div class="sd-field sd-field-span-2">
              <span class="sd-label">Session Path</span>
              <div class="sd-readonly mono">{{ session.piSessionPath }}</div>
            </div>

            <div class="sd-field">
              <span class="sd-label">Model</span>
              <template v-if="isView">
                <div class="sd-readonly">{{ formatModel(session.model) }}</div>
              </template>
              <template v-else>
                <select v-model="model" class="control">
                  <option v-for="m in allModels" :key="`${m.provider}/${m.modelId}`" :value="`${m.provider}/${m.modelId}`">
                    {{ m.displayName }} ({{ m.provider }})
                  </option>
                </select>
              </template>
            </div>

            <div class="sd-field">
              <span class="sd-label">Thinking Level</span>
              <template v-if="isView">
                <div class="sd-readonly">{{ session.thinkingLevel ?? '—' }}</div>
              </template>
              <template v-else>
                <select v-model="thinkingLevel" class="control">
                  <option value="">默认</option>
                  <option v-for="lv in thinkingLevels" :key="lv" :value="lv">{{ lv }}</option>
                </select>
              </template>
            </div>

            <div class="sd-field" v-if="agent">
              <span class="sd-label">Agent</span>
              <div class="sd-readonly">
                <router-link :to="`/agents/${agent.id}`" class="sd-link">{{ agent.name }}</router-link>
              </div>
            </div>
          </div>
        </div>

        <!-- Worker 状态 -->
        <div class="sd-section" v-if="session.worker">
          <h3 class="sd-section-title">Worker</h3>
          <div class="sd-grid">
            <div class="sd-field">
              <span class="sd-label">PID</span>
              <div class="sd-readonly mono">{{ session.worker.pid }}</div>
            </div>
            <div class="sd-field">
              <span class="sd-label">运行时间</span>
              <div class="sd-readonly">{{ workerUptime(session.worker.uptimeMs) }}</div>
            </div>
            <div class="sd-field">
              <span class="sd-label">Pending calls</span>
              <div class="sd-readonly">{{ session.worker.pendingCalls }}</div>
            </div>
          </div>
        </div>

        <!-- 时间 -->
        <div class="sd-section">
          <h3 class="sd-section-title">时间</h3>
          <div class="sd-grid">
            <div class="sd-field">
              <span class="sd-label">创建时间</span>
              <div class="sd-readonly">{{ new Date(session.createdAt).toLocaleString() }}</div>
            </div>
            <div class="sd-field">
              <span class="sd-label">最后活跃</span>
              <div class="sd-readonly">{{ timeAgo(session.lastActiveAt) }}</div>
            </div>
          </div>
        </div>

        <!-- 资源配置 -->
        <div class="sd-section sd-resources-section">
          <button type="button" class="sd-toggle" @click="resourcesExpanded = !resourcesExpanded">
            <AppIcon :name="resourcesExpanded ? 'chevron-down' : 'chevron-right'" :size="16" />
            <span class="sd-section-title">Resources</span>
          </button>

          <div v-if="resourcesExpanded" class="sd-resources-body">
            <!-- Builtin tools -->
            <div class="sd-resource-group">
              <div class="sd-resource-header">
                <span class="sd-resource-title">Builtin tools</span>
                <span class="sd-resource-count">{{ builtinToolCount }} 项</span>
              </div>
              <template v-if="isView">
                <div v-if="builtinTools === null" class="tag-list"><span class="tag tag-default">默认（全部 {{ builtinToolCount }} 项）</span></div>
                <div v-else-if="builtinTools.length" class="tag-list"><span v-for="t in builtinTools" :key="t" class="tag">{{ t }}</span></div>
                <span v-else class="sd-empty">无</span>
              </template>
              <template v-else>
                <label class="checkbox-inline"><input type="checkbox" :checked="builtinTools === null" @change="builtinTools = ($event.target as HTMLInputElement).checked ? null : [...BUILTIN_TOOLS]" /><span>使用默认</span></label>
                <div v-if="builtinTools !== null" class="resource-edit">
                  <div class="resource-edit-actions"><button type="button" class="btn-link" @click="builtinTools = [...BUILTIN_TOOLS]">全选</button><button type="button" class="btn-link" @click="builtinTools = []">清空</button></div>
                  <div class="tag-list editable"><label v-for="t in BUILTIN_TOOLS" :key="t" class="tag-check" :class="{ checked: builtinTools.includes(t) }"><input type="checkbox" :value="t" v-model="builtinTools" /><span>{{ t }}</span></label></div>
                </div>
              </template>
            </div>

            <!-- Extensions -->
            <div class="sd-resource-group">
              <div class="sd-resource-header">
                <span class="sd-resource-title">Extensions</span>
                <span class="sd-resource-count">{{ availableExtensions.names.length }} 可用</span>
              </div>
              <template v-if="isView">
                <div v-if="extensions === null" class="tag-list"><span class="tag tag-default">默认（全部）</span></div>
                <div v-else-if="extensions.length" class="tag-list"><span v-for="e in extensions" :key="e" class="tag">{{ e }}</span></div>
                <span v-else class="sd-empty">无</span>
              </template>
              <template v-else>
                <label class="checkbox-inline"><input type="checkbox" :checked="extensions === null" @change="extensions = ($event.target as HTMLInputElement).checked ? null : []" /><span>使用默认</span></label>
                <div v-if="extensions !== null" class="resource-edit">
                  <div class="resource-edit-actions"><button type="button" class="btn-link" @click="extensions = [...availableExtensions.names]">全选</button><button type="button" class="btn-link" @click="extensions = []">清空</button></div>
                  <div class="tag-list editable"><label v-for="e in availableExtensions.names" :key="e" class="tag-check" :class="{ checked: extensions.includes(e) }"><input type="checkbox" :value="e" v-model="extensions" /><span>{{ e }}</span></label></div>
                </div>
              </template>
            </div>

            <!-- Skills -->
            <div class="sd-resource-group">
              <div class="sd-resource-header">
                <span class="sd-resource-title">Skills</span>
                <span class="sd-resource-count">{{ availableSkills.length }} 可用</span>
              </div>
              <template v-if="isView">
                <div v-if="skills === null" class="tag-list"><span class="tag tag-default">默认（全部）</span></div>
                <div v-else-if="skills.length" class="tag-list"><span v-for="s in skills" :key="s" class="tag">{{ s }}</span></div>
                <span v-else class="sd-empty">无</span>
              </template>
              <template v-else>
                <label class="checkbox-inline"><input type="checkbox" :checked="skills === null" @change="skills = ($event.target as HTMLInputElement).checked ? null : []" /><span>使用默认</span></label>
                <div v-if="skills !== null" class="resource-edit">
                  <div class="resource-edit-actions"><button type="button" class="btn-link" @click="skills = skillNames">全选</button><button type="button" class="btn-link" @click="skills = []">清空</button></div>
                  <div class="tag-list editable"><label v-for="s in availableSkills" :key="s.name" class="tag-check" :class="{ checked: skills.includes(s.name) }"><input type="checkbox" :value="s.name" v-model="skills" /><span>{{ s.name }}</span></label></div>
                </div>
              </template>
            </div>

            <!-- Prompts -->
            <div class="sd-resource-group">
              <div class="sd-resource-header">
                <span class="sd-resource-title">Prompts</span>
                <span class="sd-resource-count">{{ availablePrompts.length }} 可用</span>
              </div>
              <template v-if="isView">
                <div v-if="prompts === null" class="tag-list"><span class="tag tag-default">默认（全部）</span></div>
                <div v-else-if="prompts.length" class="tag-list"><span v-for="p in prompts" :key="p" class="tag">{{ p }}</span></div>
                <span v-else class="sd-empty">无</span>
              </template>
              <template v-else>
                <label class="checkbox-inline"><input type="checkbox" :checked="prompts === null" @change="prompts = ($event.target as HTMLInputElement).checked ? null : []" /><span>使用默认</span></label>
                <div v-if="prompts !== null" class="resource-edit">
                  <div class="resource-edit-actions"><button type="button" class="btn-link" @click="prompts = promptNames">全选</button><button type="button" class="btn-link" @click="prompts = []">清空</button></div>
                  <div class="tag-list editable"><label v-for="p in availablePrompts" :key="p.name" class="tag-check" :class="{ checked: prompts.includes(p.name) }"><input type="checkbox" :value="p.name" v-model="prompts" /><span>{{ p.name }}</span></label></div>
                </div>
              </template>
            </div>
          </div>
        </div>

        <!-- System prompt -->
        <div class="sd-section" v-if="session.config?.systemPrompt || session.config?.appendSystemPrompt">
          <h3 class="sd-section-title">System Prompt</h3>
          <div v-if="session.config.systemPrompt" class="sd-prompt-block">
            <span class="sd-label">System prompt</span>
            <pre class="sd-pre">{{ session.config.systemPrompt }}</pre>
          </div>
          <div v-if="session.config.appendSystemPrompt" class="sd-prompt-block">
            <span class="sd-label">Append system prompt</span>
            <pre class="sd-pre">{{ session.config.appendSystemPrompt }}</pre>
          </div>
        </div>
      </div>
    </EditorPage>
  </div>
</template>

<style scoped>
.session-detail-wrap {
  max-width: 1240px;
  margin: 0 auto;
  width: 100%;
}

.sd-state {
  padding: 40px;
  color: var(--text-secondary);
  text-align: center;
}

.sd-content {
  max-width: 900px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* --- sections --- */
.sd-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sd-section-title {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--text);
}

.sd-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px 20px;
}

.sd-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.sd-field-span-2 { grid-column: 1 / -1; }

.sd-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.sd-readonly {
  min-height: 32px;
  display: flex;
  align-items: center;
  padding: 0 10px;
  font-size: 0.85rem;
  color: var(--text);
  background: var(--surface-subtle);
  border: 1px solid var(--border);
  border-radius: 6px;
  word-break: break-all;
}

.sd-readonly.mono {
  font-family: var(--font-mono);
  font-size: 0.8rem;
}

.sd-link {
  color: var(--accent);
  text-decoration: none;
}

.sd-link:hover {
  text-decoration: underline;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.78rem;
  font-weight: 600;
}

.status-badge.is-live {
  color: var(--success);
}

/* --- prompt blocks --- */
.sd-prompt-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sd-pre {
  margin: 0;
  padding: 10px 12px;
  font-size: 0.78rem;
  font-family: var(--font-mono);
  line-height: 1.5;
  color: var(--text);
  background: var(--surface-subtle);
  border: 1px solid var(--border);
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow-y: auto;
}

/* --- resources --- */
.sd-resources {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* --- toggle --- */
.sd-resources-section { border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.sd-toggle { display: flex; align-items: center; gap: 8px; width: 100%; padding: 12px 14px; border: 0; background: var(--surface-subtle); cursor: pointer; text-align: left; transition: background 120ms; }
.sd-toggle:hover { background: var(--surface-hover); }
.sd-toggle .sd-section-title { font-size: 0.88rem; }
.sd-resources-body { display: flex; flex-direction: column; gap: 16px; padding: 14px; }

.sd-resource-group { display: flex; flex-direction: column; gap: 4px; }
.sd-resource-header { display: flex; align-items: center; gap: 8px; }
.sd-resource-title { font-size: 0.82rem; font-weight: 650; color: var(--text); }
.sd-resource-count { font-size: 0.72rem; color: var(--text-tertiary); }
.sd-empty { font-size: 0.78rem; color: var(--text-tertiary); font-style: italic; }

.checkbox-inline { display: inline-flex; align-items: center; gap: 6px; font-size: 0.78rem; color: var(--text-secondary); cursor: pointer; }
.resource-edit { display: flex; flex-direction: column; gap: 6px; }
.resource-edit-actions { display: flex; gap: 12px; }
.btn-link { border: 0; background: none; color: var(--accent); font-size: 0.75rem; font-weight: 600; cursor: pointer; padding: 0; }
.btn-link:hover { text-decoration: underline; }

.tag-list.editable { gap: 4px; }
.tag-check { display: inline-flex; align-items: center; height: 26px; padding: 0 8px; font-size: 0.72rem; font-weight: 550; color: var(--text-secondary); background: var(--surface); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; transition: all 120ms; user-select: none; }
.tag-check input { display: none; }
.tag-check.checked { color: var(--accent-ink); background: var(--accent-soft); border-color: var(--accent); }
.tag-check:hover { border-color: var(--border-strong); }

.sd-resource-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sd-resource-title {
  font-size: 0.82rem;
  font-weight: 650;
  color: var(--text);
}

.sd-empty {
  font-size: 0.78rem;
  color: var(--text-tertiary);
  font-style: italic;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tag {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 8px;
  font-size: 0.72rem;
  font-weight: 550;
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
}

.tag.tag-default {
  color: var(--text-secondary);
  background: var(--surface-subtle);
  border-style: dashed;
}

@media (max-width: 767px) {
  .sd-grid {
    grid-template-columns: 1fr;
  }
}
</style>
