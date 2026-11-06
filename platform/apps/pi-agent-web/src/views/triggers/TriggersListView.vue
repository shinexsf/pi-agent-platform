<script setup lang="ts">
/**
 * TriggersListView — `/triggers` (change: trigger-scheduling, capability trigger-console).
 *
 * Single table across agents: name / agent / source / schedule / next / runs /
 * enabled + row actions (run-now, edit, delete, expand recent runs).
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { AgentDTO, TriggerDTO } from '@pi-agent-platform/shared-types';
import AppIcon from '../../components/ui/AppIcon.vue';
import { confirmDialog, toast } from '../../composables/useFeedback';
import { absoluteTime, relativeTime, scheduleSummary, useTriggers } from '../../composables/useTriggers';

const router = useRouter();
const route = useRoute();
const { triggers, sources, loading, error, load, runNow, remove } = useTriggers();

const agents = ref<AgentDTO[]>([]);
const agentFilter = ref<string>(typeof route.query.agentId === 'string' ? route.query.agentId : '');
const sourceFilter = ref<string>('');
const includeDisabled = ref(true);
const runningIds = ref<Set<string>>(new Set());

const filtered = computed(() =>
  triggers.value.filter((t) => {
    if (!includeDisabled.value && !t.enabled) return false;
    return true;
  }),
);

async function refresh() {
  await load({ agentId: agentFilter.value || undefined, source: sourceFilter.value || undefined, includeDisabled: true });
}

async function loadAgents() {
  try {
    const res = await fetch('/api/agents');
    if (res.ok) agents.value = (await res.json()) as AgentDTO[];
  } catch {
    /* agent names are cosmetic */
  }
}

onMounted(async () => {
  await Promise.all([refresh(), loadAgents()]);
});

// Filters live in the URL so a filtered view can be bookmarked / refreshed.
watch([agentFilter, sourceFilter, includeDisabled], () => {
  const query = { ...route.query } as Record<string, string>;
  if (agentFilter.value) query.agentId = agentFilter.value;
  else delete query.agentId;
  void router.replace({ query });
  void refresh();
});

async function fire(trigger: TriggerDTO) {
  runningIds.value.add(trigger.id);
  try {
    const result = await runNow(trigger.id);
    if (result.status === 'dispatched') toast(`已派发「${trigger.name}」`, 'success');
    else if (result.status === 'skipped') toast(`跳过：${result.error ?? 'overlap'}`, 'warning');
    else if (result.status === 'disabled') toast('触发器已停用或平台已急停', 'warning');
    else if (result.status === 'duplicate') toast('重复事件（幂等键命中）', 'info');
    else toast(`失败：${result.error ?? 'unknown'}`, 'error');
    await refresh();
  } catch (err) {
    toast((err as Error).message, 'error');
  } finally {
    runningIds.value.delete(trigger.id);
  }
}

async function removeTrigger(trigger: TriggerDTO) {
  const ok = await confirmDialog({
    title: '删除触发器',
    message: `确定删除「${trigger.name}」？历史运行记录会保留。`,
    confirmText: '删除',
    destructive: true,
  });
  if (!ok) return;
  try {
    await remove(trigger.id);
    toast('触发器已删除', 'success');
    await refresh();
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

async function toggleEnabled(trigger: TriggerDTO) {
  try {
    const res = await fetch(`/api/triggers/${trigger.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !trigger.enabled }),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);
    await refresh();
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

</script>

<template>
  <section class="page-shell" aria-labelledby="triggers-title">
    <div class="page-heading">
      <div class="page-heading-copy">
        <h1 id="triggers-title" class="page-title">触发器</h1>
        <p class="page-subtitle">定时 / 一次性 / Webhook 驱动 agent，结果通过通知收件箱回来</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" type="button" @click="router.push('/triggers/new')">
          <AppIcon name="plus" :size="16" />
          新建触发器
        </button>
      </div>
    </div>

    <div class="surface-panel" :aria-busy="loading">
      <div class="panel-toolbar">
        <div class="panel-toolbar-group">
          <select v-model="agentFilter" class="control" aria-label="按 agent 过滤">
            <option value="">全部 agent</option>
            <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
          </select>
          <select v-model="sourceFilter" class="control" aria-label="按来源过滤">
            <option value="">全部来源</option>
            <option v-for="s in sources" :key="s.source" :value="s.source">{{ s.label }}</option>
          </select>
          <label class="toolbar-check">
            <input v-model="includeDisabled" type="checkbox" />
            显示停用
          </label>
        </div>
        <div class="panel-toolbar-group toolbar-meta">
          <span class="page-count">{{ filtered.length }} 个触发器</span>
          <button
            class="btn btn-secondary btn-icon"
            type="button"
            :disabled="loading"
            aria-label="刷新"
            @click="refresh()"
          >
            <AppIcon name="refresh" :size="16" />
          </button>
        </div>
      </div>

      <div v-if="loading" class="loading-caption">加载中…</div>

      <div v-else-if="error" class="state-panel">
        <div class="state-content">
          <span class="state-icon"><AppIcon name="alert" :size="23" /></span>
          <h2 class="state-title">触发器加载失败</h2>
          <p class="state-copy">{{ error }}</p>
          <button class="btn btn-secondary state-action" type="button" @click="refresh()">重试</button>
        </div>
      </div>

      <div v-else-if="filtered.length === 0" class="state-panel">
        <div class="state-content">
          <span class="state-icon"><AppIcon name="automation" :size="23" /></span>
          <h2 class="state-title">还没有触发器</h2>
          <p class="state-copy">
            让 agent 在你不在的时候也干活：每天 9 点磁盘巡检、CI 失败告警、一次性延迟复盘。
          </p>
          <button class="btn btn-primary state-action" type="button" @click="router.push('/triggers/new')">
            新建触发器
          </button>
        </div>
      </div>

      <table v-else class="data-table trigger-table">
        <thead>
          <tr>
            <th scope="col">名称</th>
            <th scope="col">Agent</th>
            <th scope="col">来源</th>
            <th scope="col">计划</th>
            <th scope="col">下次</th>
            <th scope="col">上次</th>
            <th scope="col">运行</th>
            <th scope="col">状态</th>
            <th scope="col" class="col-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="trigger in filtered" :key="trigger.id" :class="{ 'row-disabled': !trigger.enabled }">
              <td>
                <button class="link-btn" type="button" @click="router.push(`/triggers/${trigger.id}`)">
                  {{ trigger.name }}
                </button>
              </td>
              <td class="muted">{{ trigger.agentName ?? trigger.agentId.slice(0, 8) }}</td>
              <td><span class="chip">{{ trigger.source }}</span></td>
              <td class="mono">{{ scheduleSummary(trigger) }}</td>
              <td class="muted" :title="absoluteTime(trigger.nextAt)">{{ relativeTime(trigger.nextAt) }}</td>
              <td class="muted" :title="absoluteTime(trigger.lastFiredAt)">{{ relativeTime(trigger.lastFiredAt) }}</td>
              <td class="muted mono">{{ trigger.runsCount }}/{{ trigger.maxRuns ?? '∞' }}</td>
              <td>
                <button class="status-toggle" type="button" @click="toggleEnabled(trigger)">
                  <span class="status-dot" :class="trigger.enabled ? 'is-live' : 'is-idle'" />
                  {{ trigger.enabled ? '启用' : '停用' }}
                </button>
              </td>
              <td class="col-actions">
                <button
                  class="btn-icon-sm"
                  type="button"
                  title="立即运行"
                  :disabled="runningIds.has(trigger.id)"
                  @click="fire(trigger)"
                >
                  <AppIcon name="play" :size="14" />
                </button>
                <button class="btn-icon-sm" type="button" title="编辑" @click="router.push(`/triggers/${trigger.id}`)">
                  <AppIcon name="edit" :size="14" />
                </button>
                <button class="btn-icon-sm" type="button" title="删除" @click="removeTrigger(trigger)">
                  <AppIcon name="trash" :size="14" />
                </button>
              </td>
            </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.page-subtitle {
  margin: 6px 0 0;
  color: var(--text-tertiary);
  font-size: 0.86rem;
}

.toolbar-check {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  color: var(--text-secondary);
  font-size: 0.82rem;
  white-space: nowrap;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.86rem;
}

.data-table th {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text-tertiary);
  font-size: 0.74rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-align: left;
  text-transform: uppercase;
  white-space: nowrap;
}

.data-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: middle;
}

.row-disabled {
  opacity: 0.55;
}

.muted {
  color: var(--text-tertiary);
}

.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  font-size: 0.8rem;
}

.chip {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--surface-subtle);
  border: 1px solid var(--border-subtle);
  color: var(--text-secondary);
  font-size: 0.74rem;
}

.link-btn {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}

.link-btn:hover {
  color: var(--accent, #3b82f6);
}

.status-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 0.8rem;
  cursor: pointer;
}

.status-toggle:hover {
  background: var(--surface-hover);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--border-strong);
}

.status-dot.is-live {
  background: #22c55e;
}

.status-dot.is-idle {
  background: var(--border-strong);
}

.col-actions {
  text-align: right;
  white-space: nowrap;
}

/* 行内操作：给按钮之间留气口，别挤在一起 */
.col-actions .btn-icon-sm {
  margin-left: 6px;
}

.col-actions .btn-icon-sm:first-child {
  margin-left: 0;
}

.loading-caption {
  padding: 18px;
  color: var(--text-tertiary);
  font-size: 0.84rem;
}
</style>
