<script setup lang="ts">
/**
 * McpSelectionGroup — MCP 的配置区块，三处编辑面共用（change: platform-mcp-catalog）。
 *
 * 一个总开关（`AgentConfig.mcp.enabled`）+ 平台目录里的 server 勾选（`mcp.servers`）。
 * **关掉总开关会同时清空 server 选择**（开关就是生效条件，留着无效选择只会造成“看着还在、实际不连”的误解）。
 * 打开时按需手动勾选；目录里已不存在的名字以黄标幽灵项展示，可一键清理。
 */
import { computed } from 'vue';
import type { McpCatalogServerDTO } from '@pi-agent-platform/api-types';
import InfoTip from '../ui/InfoTip.vue';
import { MCP_SWITCH_HINT } from '../../constants/builtin-tools';

const enabled = defineModel<boolean>('enabled', { required: true });
const servers = defineModel<string[]>('servers', { required: true });

const props = withDefaults(
  defineProps<{
    /** 平台目录（`GET /api/config/mcp-servers`）。 */
    catalog: McpCatalogServerDTO[];
    /** 目录解析错误（逐条）。 */
    errors?: string[];
    /** 同时被 pi 自己的 mcp.json 定义的 server 名。 */
    conflicts?: string[];
    title?: string;
    hint?: string;
    /** 只读展示（例如模板预览）。 */
    disabled?: boolean;
    /** 加载中（目录还没回来时别让用户以为「没有 server」）。 */
    loading?: boolean;
  }>(),
  {
    errors: () => [],
    conflicts: () => [],
    title: 'MCP',
    hint: MCP_SWITCH_HINT,
    disabled: false,
    loading: false,
  },
);

const catalogNames = computed(() => new Set(props.catalog.map((s) => s.name)));

/** 已勾选但目录里没有的名字（历史残留）。 */
const ghostServers = computed(() => servers.value.filter((name) => !catalogNames.value.has(name)));

/** 已勾选且与 pi mcp.json 重名 —— 平台开关对它们不生效。 */
const conflictServers = computed(() => servers.value.filter((name) => props.conflicts.includes(name)));

const summary = computed(() => {
  if (!enabled.value) return '未启用';
  return servers.value.length > 0 ? `已启用 · ${servers.value.length} 个 server` : '已启用 · 未选 server';
});

function setEnabled(next: boolean): void {
  enabled.value = next;
  // 关掉总开关 = 不连任何 server，同时清空选择，避免留下不生效的残留
  if (!next) servers.value = [];
}

function toggleServer(name: string, checked: boolean): void {
  const next = new Set(servers.value);
  if (checked) next.add(name);
  else next.delete(name);
  servers.value = [...next];
}

function pruneGhosts(): void {
  servers.value = servers.value.filter((name) => catalogNames.value.has(name));
}
</script>

<template>
  <div class="resource-group">
    <div class="resource-group-header">
      <span class="resource-group-title">{{ title }}</span>
      <InfoTip :text="hint" :width="340" />
      <span class="resource-group-count">{{ summary }}</span>
      <button v-if="ghostServers.length > 0 && !disabled" class="prune-btn" @click="pruneGhosts">
        清理无效项
      </button>
    </div>

    <div class="mcp-switch">
      <label class="mcp-toggle">
        <input
          type="checkbox"
          :checked="enabled"
          :disabled="disabled"
          @change="setEnabled(($event.target as HTMLInputElement).checked)"
        />
        <span>启用 MCP</span>
      </label>
      <span class="mcp-catalog-path">{{ loading ? '加载目录…' : '目录：平台 mcp.json' }}</span>
    </div>

    <div :class="['tag-list', { locked: !enabled }]">
      <label
        v-for="server in catalog"
        :key="server.name"
        :class="['tag-check', { checked: servers.includes(server.name), 'tag-invalid': conflictServers.includes(server.name) }]"
        :title="server.description || server.name"
      >
        <input
          type="checkbox"
          :checked="servers.includes(server.name)"
          :disabled="disabled || !enabled"
          @change="toggleServer(server.name, ($event.target as HTMLInputElement).checked)"
        />
        <span>{{ server.name }}</span>
        <span class="mcp-exposure">{{ server.exposure }}</span>
      </label>

      <!-- 幽灵项：已勾选但目录里已不存在 -->
      <label
        v-for="name in ghostServers"
        :key="`ghost-${name}`"
        class="tag-check checked tag-invalid"
        title="目录中已不存在这个 server"
      >
        <input type="checkbox" checked :disabled="disabled" @change="toggleServer(name, false)" />
        <span>{{ name }}</span>
        <span class="mcp-exposure">失效</span>
      </label>

      <span v-if="catalog.length === 0 && !loading" class="mcp-empty">
        平台目录里还没有 server（编辑 ~/.pi/server/mcp.json 后刷新）
      </span>
    </div>

    <p v-if="conflictServers.length > 0" class="mcp-note warn">
      {{ conflictServers.join('、') }} 也定义在 pi 自己的 mcp.json 里，pi 会优先使用它 —— 平台开关对这些 server 无效。
    </p>
    <p v-if="errors.length > 0" class="mcp-note warn">
      目录有 {{ errors.length }} 条无效项：{{ errors[0] }}
    </p>
  </div>
</template>

<style scoped>
.resource-group {
  margin-bottom: 18px;
}

.resource-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.resource-group-title {
  font-size: 0.82rem;
  font-weight: 650;
}

.resource-group-count {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

.prune-btn {
  margin-left: auto;
  font-size: 0.7rem;
  padding: 2px 7px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
}

.prune-btn:hover {
  color: #d97706;
  border-color: #f59e0b66;
}

.mcp-switch {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.mcp-catalog-path {
  font-size: 0.7rem;
  color: var(--text-tertiary);
}

/* 总开关保留原生勾选框（不是 tag chip） */
.mcp-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.78rem;
  color: var(--text);
  cursor: pointer;
  user-select: none;
}

.mcp-toggle input {
  margin: 0;
  cursor: pointer;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-list.locked {
  opacity: 0.55;
}

.tag-check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 0.72rem;
  font-weight: 550;
  cursor: pointer;
  user-select: none;
  transition: all 120ms;
}

/* 与 agent / 会话 / 模板编辑页的 tag-check 一致：隐藏原生勾选框，用选中态配色表达勾选 */
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

.tag-check.tag-invalid {
  border-color: #d97706 !important;
  color: #b45309 !important;
  background: rgba(245, 158, 11, 0.12) !important;
}

.tag-check.tag-invalid span:first-of-type {
  text-decoration: line-through;
  text-decoration-color: #d97706;
}

.mcp-exposure {
  font-size: 0.62rem;
  color: var(--text-tertiary);
  font-weight: 400;
  opacity: 0.85;
}

.mcp-exposure::before {
  content: '·';
  margin-right: 3px;
  opacity: 0.7;
}

.mcp-empty {
  font-size: 0.72rem;
  color: var(--text-tertiary);
}

.mcp-note {
  margin: 6px 0 0;
  font-size: 0.7rem;
  color: var(--text-tertiary);
}

.mcp-note.warn {
  color: #b45309;
}
</style>
