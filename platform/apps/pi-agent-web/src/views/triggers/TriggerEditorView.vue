<script setup lang="ts">
/**
 * TriggerEditorView — `/triggers/new` and `/triggers/:id`
 * (change: trigger-scheduling, capability trigger-console).
 *
 * Left: form. Right: recent runs. The `source`-specific fields come from a
 * tiny per-source renderer so the UI stays aligned with `SourceSpec.validateConfig`
 * (server is the single validator; this only shapes input).
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { AgentDTO, TriggerDTO, TriggerRunDTO, TriggerSourceInfo } from '@pi-agent-platform/shared-types';
import AppIcon from '../../components/ui/AppIcon.vue';
import { confirmDialog, toast } from '../../composables/useFeedback';
import { absoluteTime, relativeTime, useTriggers } from '../../composables/useTriggers';

const route = useRoute();
const router = useRouter();
const api = useTriggers();

const isNew = computed(() => !route.params.id || route.params.id === 'new');
const triggerId = computed(() => (isNew.value ? '' : String(route.params.id)));

const agents = ref<AgentDTO[]>([]);
/** Agent 的会话（reuse 模式下可绑定其中一个；复用既有 GET /api/sessions?agent_id=）。 */
const agentSessions = ref<Array<{ id: string; title: string | null; updatedAt?: number; model?: string }>>([]);
const sessionsLoading = ref(false);
/** 初次填充表单完成前不进 watch 的"换 agent 就清绑定"分支（否则编辑页加载时会被自己清掉）。 */
const hydrated = ref(false);
const sources = ref<TriggerSourceInfo[]>([]);
const recentRuns = ref<TriggerRunDTO[]>([]);
const saving = ref(false);
const loading = ref(true);
const fieldError = ref<string | null>(null);
const secretDialog = ref<{ secret: string; triggerId: string } | null>(null);

const form = ref({
  agentId: typeof route.query.agentId === 'string' ? route.query.agentId : '',
  name: '',
  source: 'cron',
  prompt: '',
  sessionMode: 'new' as 'new' | 'reuse',
  /** 空 = 首次触发时自动创建并固定；有值 = 固定写这个会话（必须是本 agent 的）。 */
  sessionId: '' as string,
  enabled: true,
  maxRuns: '' as string,
  // source-specific
  cronExpr: '0 9 * * *',
  cronTz: 'Asia/Shanghai',
  onceAt: '',
});

const isEdit = computed(() => !isNew.value);
const sourceInfo = computed(() => sources.value.find((s) => s.source === form.value.source));
const secretEnding = ref<string | null>(null);

const TIMEZONES = ['Asia/Shanghai', 'Asia/Tokyo', 'UTC', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];

function localInputToMs(value: string): number {
  // `<input type="datetime-local">` yields "YYYY-MM-DDTHH:mm" in LOCAL time.
  return new Date(value).getTime();
}

function msToLocalInput(ms: number | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function buildConfig(): Record<string, unknown> {
  if (form.value.source === 'cron') {
    return { expr: form.value.cronExpr.trim(), tz: form.value.cronTz.trim() || 'Asia/Shanghai' };
  }
  if (form.value.source === 'once') {
    return { at: localInputToMs(form.value.onceAt) };
  }
  // webhook: secret is server-generated; keep it opaque here.
  return {};
}

async function loadAgentSessions() {
  if (!form.value.agentId) {
    agentSessions.value = [];
    return;
  }
  sessionsLoading.value = true;
  try {
    const res = await fetch(`/api/sessions?agent_id=${encodeURIComponent(form.value.agentId)}&pageSize=100`);
    if (res.ok) {
      const data = (await res.json()) as { sessions?: Array<{ id: string; title: string | null; updatedAt?: number; model?: string }> };
      agentSessions.value = data.sessions ?? [];
    }
  } catch {
    agentSessions.value = [];
  } finally {
    sessionsLoading.value = false;
  }
}

function sessionLabel(id: string): string {
  const s = agentSessions.value.find((x) => x.id === id);
  if (!s) return `${id.slice(0, 8)}…（不在该 agent 的会话列表里）`;
  const title = s.title || '(未命名)';
  return `${title} · ${id.slice(0, 8)}${s.updatedAt ? ` · ${relativeTime(s.updatedAt)}` : ''}`;
}

// Bound session may point at a session outside the first page / another agent's
// stale id — keep the option visible so the select never silently shows the wrong one.
const boundSessionMissing = computed(
  () => !!form.value.sessionId && !agentSessions.value.some((s) => s.id === form.value.sessionId),
);

// 换 agent 时旧会话列表作废（切换 agent 会清掉绑定）。
watch(
  () => form.value.agentId,
  (next, prev) => {
    if (hydrated.value && next !== prev) form.value.sessionId = '';
    void loadAgentSessions();
  },
);

async function loadAll() {
  loading.value = true;
  try {
    const [agentsRes, listRes] = await Promise.all([fetch('/api/agents'), fetch('/api/triggers?includeDisabled=1')]);
    if (agentsRes.ok) agents.value = (await agentsRes.json()) as AgentDTO[];
    if (listRes.ok) sources.value = ((await listRes.json()) as { sources: TriggerSourceInfo[] }).sources;

    if (!isNew.value) {
      const detail = await api.get(triggerId.value);
      applyTrigger(detail);
      recentRuns.value = detail.recentRuns ?? [];
      const cfg = detail.config as Record<string, unknown>;
      if (typeof cfg.secretEnding === 'string') secretEnding.value = cfg.secretEnding;
    }
    // 新建页也要立刻有会话可选（agentId 来自 query，watch 不会触发）。
    await loadAgentSessions();
    hydrated.value = true;
  } catch (err) {
    toast((err as Error).message, 'error');
  } finally {
    loading.value = false;
  }
}

function applyTrigger(t: TriggerDTO) {
  form.value.agentId = t.agentId;
  form.value.name = t.name;
  form.value.source = t.source;
  form.value.prompt = t.prompt;
  form.value.sessionMode = t.sessionMode;
  form.value.sessionId = t.sessionId ?? '';
  form.value.enabled = t.enabled;
  form.value.maxRuns = t.maxRuns === null ? '' : String(t.maxRuns);
  const cfg = t.config as Record<string, unknown>;
  if (t.source === 'cron') {
    form.value.cronExpr = String(cfg.expr ?? '');
    form.value.cronTz = String(cfg.tz ?? 'Asia/Shanghai');
  } else if (t.source === 'once') {
    form.value.onceAt = msToLocalInput(Number(cfg.at) || null);
  }
}

onMounted(loadAll);

async function save() {
  fieldError.value = null;
  if (!form.value.name.trim()) return (fieldError.value = '名称不能为空');
  if (!form.value.prompt.trim()) return (fieldError.value = '指令不能为空');
  if (isNew.value && !form.value.agentId) return (fieldError.value = '请选择 agent');
  if (form.value.source === 'once' && !form.value.onceAt) return (fieldError.value = '请选择触发时刻');

  saving.value = true;
  try {
    if (isNew.value) {
      const created = await api.create({
        agentId: form.value.agentId,
        name: form.value.name.trim(),
        source: form.value.source,
        config: buildConfig(),
        prompt: form.value.prompt,
        sessionMode: form.value.sessionMode,
        ...(form.value.sessionMode === 'reuse' ? { sessionId: form.value.sessionId || null } : {}),
        enabled: form.value.enabled,
        ...(form.value.maxRuns ? { maxRuns: Number(form.value.maxRuns) } : {}),
      });
      if (created.secret) {
        secretDialog.value = { secret: created.secret, triggerId: created.id };
      } else {
        toast('触发器已创建', 'success');
        await router.push(`/triggers/${created.id}`);
      }
    } else {
      await api.update(triggerId.value, {
        name: form.value.name.trim(),
        config: buildConfig(),
        prompt: form.value.prompt,
        sessionMode: form.value.sessionMode,
        ...(form.value.sessionMode === 'reuse' ? { sessionId: form.value.sessionId || null } : {}),
        enabled: form.value.enabled,
        maxRuns: form.value.maxRuns ? Number(form.value.maxRuns) : null,
        reschedule: true,
      });
      toast('已保存', 'success');
      await loadAll();
    }
  } catch (err) {
    fieldError.value = (err as Error).message;
  } finally {
    saving.value = false;
  }
}

async function refreshRuns() {
  if (isNew.value) return;
  try {
    recentRuns.value = await api.runs(triggerId.value, 50);
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

async function fireNow() {
  try {
    const result = await api.runNow(triggerId.value);
    const map: Record<string, [string, 'success' | 'warning' | 'error' | 'info']> = {
      dispatched: ['已派发', 'success'],
      skipped: [`跳过：${result.error ?? 'overlap'}`, 'warning'],
      disabled: ['已停用或平台急停', 'warning'],
      duplicate: ['重复事件', 'info'],
      failed: [`失败：${result.error ?? ''}`, 'error'],
    };
    const [msg, variant] = map[result.status] ?? ['未知结果', 'info'];
    toast(msg, variant);
    recentRuns.value = await api.runs(triggerId.value, 50);
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

async function rotate() {
  const ok = await confirmDialog({
    title: '轮换 webhook 密钥',
    message: '旧密钥会立即失效。新密钥只显示这一次。',
    confirmText: '轮换',
  });
  if (!ok) return;
  try {
    const secret = await api.rotateSecret(triggerId.value);
    secretDialog.value = { secret, triggerId: triggerId.value };
    await loadAll();
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

async function removeTrigger() {
  const ok = await confirmDialog({
    title: '删除触发器',
    message: '历史运行记录会保留。',
    confirmText: '删除',
    destructive: true,
  });
  if (!ok) return;
  try {
    await api.remove(triggerId.value);
    toast('触发器已删除', 'success');
    await router.push('/triggers');
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

function closeSecretDialog() {
  const id = secretDialog.value?.triggerId;
  secretDialog.value = null;
  if (id && isNew.value) void router.push(`/triggers/${id}`);
  else void loadAll();
}

const curlSample = computed(() => {
  if (!secretDialog.value) return '';
  return `curl -X POST "${window.location.origin}/api/hooks/${secretDialog.value.triggerId}" \\
  -H "authorization: Bearer ${secretDialog.value.secret}" \\
  -H "content-type: application/json" \\
  -d '{"alert":"ci failed","branch":"main"}'`;
});
</script>

<template>
  <section class="page-shell">
    <div class="page-heading">
      <div class="page-heading-copy">
        <h1 class="page-title">{{ isNew ? '新建触发器' : form.name || '触发器' }}</h1>
        <p class="page-subtitle">
          {{ isNew ? '先选 agent，再选来源' : `来源 ${form.source}（创建后不可修改）` }}
        </p>
      </div>
      <div class="page-actions">
        <button class="btn btn-secondary" type="button" @click="router.push('/triggers')">返回列表</button>
        <button v-if="!isNew" class="btn btn-secondary" type="button" @click="fireNow">
          <AppIcon name="play" :size="15" />
          立即运行
        </button>
        <button class="btn btn-primary" type="button" :disabled="saving" @click="save">
          {{ isNew ? '创建' : '保存' }}
        </button>
      </div>
    </div>

    <div v-if="loading" class="loading-caption">加载中…</div>

    <div v-else class="editor-grid">
      <div class="surface-panel editor-panel">
        <div class="form-body">
          <label v-if="isNew" class="field">
            <span>Agent</span>
            <select v-model="form.agentId" class="control">
              <option value="">选择 agent…</option>
              <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
            </select>
          </label>
          <div v-else class="field">
            <span>Agent</span>
            <div class="readonly">
              {{ agents.find((a: AgentDTO) => a.id === form.agentId)?.name ?? form.agentId }}
            </div>
          </div>

          <label class="field">
            <span>名称</span>
            <input v-model="form.name" class="control" placeholder="例如 磁盘巡检" />
          </label>

          <div class="field">
            <span>来源</span>
            <div v-if="isNew" class="source-cards">
              <button
                v-for="s in sources"
                :key="s.source"
                type="button"
                class="source-card"
                :class="{ active: form.source === s.source }"
                @click="form.source = s.source"
              >
                <strong>{{ s.label }}</strong>
                <span>{{ s.description }}</span>
              </button>
            </div>
            <div v-else class="readonly">{{ sourceInfo?.label ?? form.source }}</div>
          </div>

          <label v-if="form.source === 'cron'" class="field">
            <span>cron 表达式</span>
            <input v-model="form.cronExpr" class="control mono" placeholder="0 9 * * *" />
            <span class="hint">分 时 日 月 周；最小间隔 5 分钟</span>
          </label>
          <label v-if="form.source === 'cron'" class="field">
            <span>时区</span>
            <input v-model="form.cronTz" class="control" list="tz-list" />
            <datalist id="tz-list">
              <option v-for="tz in TIMEZONES" :key="tz" :value="tz" />
            </datalist>
          </label>

          <label v-if="form.source === 'once'" class="field">
            <span>触发时刻（本地时区）</span>
            <input v-model="form.onceAt" type="datetime-local" class="control" />
          </label>

          <div v-if="form.source === 'webhook'" class="field">
            <span>密钥</span>
            <div v-if="isNew" class="readonly">创建后自动生成，只显示一次</div>
            <div v-else class="secret-row">
              <span class="readonly">已设置 ●●●●{{ secretEnding ?? '????' }}</span>
              <button class="btn btn-secondary btn-sm" type="button" @click="rotate">轮换密钥</button>
            </div>
            <div v-if="!isNew" class="hint mono">POST /api/hooks/{{ triggerId }} · Authorization: Bearer &lt;secret&gt;</div>
          </div>

          <label class="field">
            <span>指令（进入信封的 instruction）</span>
            <textarea v-model="form.prompt" class="control" rows="5" placeholder="检查磁盘使用率，超过 90% 就告警" />
          </label>

          <div class="field">
            <span>会话模式</span>
            <div class="radio-row">
              <label><input v-model="form.sessionMode" type="radio" value="new" /> 每次新建会话</label>
              <label><input v-model="form.sessionMode" type="radio" value="reuse" /> 复用同一会话</label>
            </div>
            <span class="hint">
              {{ form.sessionMode === 'new'
                ? '每次触发开一个新会话，便于按次回看'
                : '所有触发共用一个会话；idle 被回收后下次触发自动恢复' }}
            </span>
          </div>

          <label v-if="form.sessionMode === 'reuse'" class="field">
            <span>目标会话</span>
            <select v-model="form.sessionId" class="control" :disabled="sessionsLoading || !form.agentId">
              <option value="">（留空：首次触发时自动创建，之后固定复用）</option>
              <option v-if="form.sessionId && boundSessionMissing" :value="form.sessionId">
                {{ sessionLabel(form.sessionId) }}
              </option>
              <option v-for="s in agentSessions" :key="s.id" :value="s.id">{{ sessionLabel(s.id) }}</option>
            </select>
            <span class="hint">
              选了就写这个会话（必须是本 agent 的会话，idle 回收后自动恢复）；选第一项可解绑回"自动创建"
            </span>
          </label>

          <label class="field">
            <span>最大运行次数</span>
            <input v-model="form.maxRuns" class="control" type="number" min="1" placeholder="留空 = 不限" />
            <span class="hint">达到次数后自动停用（once 固定为 1）</span>
          </label>

          <label class="field-inline">
            <input v-model="form.enabled" type="checkbox" />
            <span>启用</span>
          </label>

          <p v-if="fieldError" class="field-error">{{ fieldError }}</p>
        </div>

        <div v-if="!isNew" class="form-footer">
          <button class="btn btn-danger" type="button" @click="removeTrigger">
            <AppIcon name="trash" :size="15" />
            删除触发器
          </button>
        </div>
      </div>

      <div class="surface-panel runs-panel">
        <div class="panel-toolbar">
          <div class="panel-toolbar-group"><strong>运行记录</strong></div>
          <div class="panel-toolbar-group">
            <button
              class="btn btn-secondary btn-icon"
              type="button"
              aria-label="刷新运行记录"
              @click="refreshRuns"
            >
              <AppIcon name="refresh" :size="15" />
            </button>
          </div>
        </div>
        <div v-if="isNew" class="loading-caption">创建后可查看运行记录</div>
        <div v-else-if="recentRuns.length === 0" class="loading-caption">还没有运行记录</div>
        <ul v-else class="run-list">
          <li v-for="run in recentRuns" :key="run.id" class="run-item">
            <span class="run-status" :class="`is-${run.status}`">{{ run.status }}</span>
            <span class="muted">{{ run.triggeredBy }}</span>
            <span class="muted" :title="absoluteTime(run.startedAt)">{{ relativeTime(run.startedAt) }}</span>
            <a
              v-if="run.sessionId"
              class="mono link"
              :href="`${$router.options.history.base || ''}/chat/${run.sessionId}`"
              target="_blank"
              rel="noopener"
            >session {{ run.sessionId.slice(0, 8) }}</a>
            <span v-if="run.error" class="run-error" :title="run.error">{{ run.error }}</span>
          </li>
        </ul>
      </div>
    </div>

    <!-- Secret is shown EXACTLY once (create / rotate). -->
    <div v-if="secretDialog" class="modal-backdrop" @click.self="closeSecretDialog">
      <div class="modal">
        <h2 class="modal-title">Webhook 密钥（只显示这一次）</h2>
        <p class="hint">关闭后无法再次查看；只能轮换。</p>
        <pre class="code-block">{{ secretDialog.secret }}</pre>
        <pre class="code-block">{{ curlSample }}</pre>
        <div class="modal-actions">
          <button class="btn btn-primary" type="button" @click="closeSecretDialog">我已保存</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.page-subtitle {
  margin: 6px 0 0;
  color: var(--text-tertiary);
  font-size: 0.86rem;
}

.editor-grid {
  display: grid;
  gap: 18px;
  grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
}

@media (max-width: 1000px) {
  .editor-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.form-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.84rem;
  color: var(--text-secondary);
}

.field-inline {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 0.86rem;
  color: var(--text-secondary);
}

.readonly {
  padding: 8px 10px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  color: var(--text-tertiary);
  font-size: 0.84rem;
}

.hint {
  color: var(--text-tertiary);
  font-size: 0.76rem;
}

.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
}

.source-cards {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.source-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.78rem;
  text-align: left;
}

.source-card.active {
  border-color: var(--accent, #3b82f6);
  background: var(--surface-hover);
}

.source-card strong {
  color: var(--text);
  font-size: 0.88rem;
}

.radio-row {
  display: flex;
  gap: 18px;
  font-size: 0.84rem;
}

.secret-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.field-error {
  margin: 0;
  color: #dc2626;
  font-size: 0.82rem;
}

.form-footer {
  padding: 14px 20px;
  border-top: 1px solid var(--border-subtle);
}

.run-list {
  margin: 0;
  padding: 8px 14px;
  list-style: none;
}

.run-item {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 5px 0;
  border-bottom: 1px solid var(--border-subtle);
  font-size: 0.8rem;
}

.run-status {
  min-width: 58px;
  font-weight: 600;
}

.run-status.is-fired {
  color: #16a34a;
}

.run-status.is-failed {
  color: #dc2626;
}

.run-status.is-skipped,
.run-status.is-missed {
  color: var(--text-tertiary);
}

.run-error {
  overflow: hidden;
  max-width: 260px;
  color: #dc2626;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.muted {
  color: var(--text-tertiary);
}

.link {
  color: var(--accent, #3b82f6);
  text-decoration: none;
}

.loading-caption {
  padding: 18px;
  color: var(--text-tertiary);
  font-size: 0.84rem;
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  background: rgb(0 0 0 / 45%);
}

.modal {
  width: min(620px, 92vw);
  padding: 22px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--surface-raised);
  box-shadow: var(--shadow-soft);
}

.modal-title {
  margin: 0 0 6px;
  font-size: 1.02rem;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

.code-block {
  overflow-x: auto;
  margin: 10px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  background: var(--surface-subtle);
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  font-size: 0.78rem;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
