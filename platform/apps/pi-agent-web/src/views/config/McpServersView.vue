<script setup lang="ts">
/**
 * McpServersView — 平台 MCP 目录（config/MCP）。
 *
 * server 定义只维护一份：`~/.pi/server/mcp.json`（pi 同格式，可用 PI_SERVER_MCP_CONFIG 覆盖）。
 * agent / 会话 / 模板只存 server 名字。本页负责查看 + 增删改定义；未在目录里的名字在勾选面板
 * 会被标成幽灵项。
 *
 * 保存时保留平台不建模的字段（timeout / headers 之外的私有字段、顶层 autoEnableCodemode 等），
 * 因为文件是 pi 的形状，pi 会直接消费它们。
 */
import { computed, onMounted, ref } from 'vue';
import type { McpCatalogServerDTO } from '@pi-agent-platform/api-types';
import AppIcon from '../../components/ui/AppIcon.vue';
import InfoTip from '../../components/ui/InfoTip.vue';
import { confirmDelete, toast } from '../../composables/useFeedback';
import {
  invalidateMcpCatalog,
  useMcpCatalog,
} from '../../composables/useMcpCatalog';

const PAGE_HINT =
  '平台 MCP 目录：server 定义集中在这里维护（文件 ~/.pi/server/mcp.json，pi 同格式）。' +
  'agent / 会话 / 模板只勾选要用的 server 名字；pi 自己 mcp.json 里的同名 server 优先，目录里的同名项不会生效。';

type Exposure = 'codemode' | 'deferred' | 'direct' | 'hidden';

type CatalogServer = McpCatalogServerDTO;

const EXPOSURES: Array<{ value: Exposure; label: string; hint: string }> = [
  { value: 'codemode', label: 'codemode', hint: '默认：工具在 codemode 沙箱里用，模型不直接看到 schema' },
  { value: 'deferred', label: 'deferred', hint: '延迟加载：靠 tool_search 检索后再调用' },
  { value: 'direct', label: 'direct', hint: '直接声明给模型（占 token，但无需额外工具）' },
  { value: 'hidden', label: 'hidden', hint: '不暴露给模型' },
];

const {
  servers,
  errors,
  conflicts,
  path: catalogPath,
  loading,
  load,
} = useMcpCatalog();
const saving = ref(false);

/** 正在编辑的 server 原始名（null = 新增）。 */
const editingName = ref<string | null>(null);
const form = ref<ServerForm>(blankForm());

interface ServerForm {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
  exposure: Exposure;
  enabled: boolean;
  description: string;
}

function blankForm(): ServerForm {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    argsText: '',
    envText: '',
    url: '',
    headersText: '',
    exposure: 'codemode',
    enabled: true,
    description: '',
  };
}

const editing = computed(() => editingName.value !== null);
const showEditor = computed(() => editing.value || creating.value);

const creating = ref(false);

onMounted(() => {
  void load();
});

/** 目录改过以后必须丢掉模块级缓存，否则三处勾选面板还看旧数据。 */
async function reloadAfterMutation(): Promise<void> {
  invalidateMcpCatalog();
  await load();
}

function startCreate(): void {
  creating.value = true;
  editingName.value = null;
  form.value = blankForm();
}

function startEdit(server: CatalogServer): void {
  creating.value = false;
  editingName.value = server.name;
  const config = server.config;
  form.value = {
    name: server.name,
    transport: typeof config.url === 'string' && config.url ? 'http' : 'stdio',
    command: typeof config.command === 'string' ? config.command : '',
    argsText: Array.isArray(config.args) ? config.args.map(String).join('\n') : '',
    envText: recordToLines(config.env),
    url: typeof config.url === 'string' ? config.url : '',
    headersText: recordToLines(config.headers),
    exposure: server.exposure,
    enabled: config.enabled !== false,
    description: server.description ?? '',
  };
}

function cancelEdit(): void {
  creating.value = false;
  editingName.value = null;
  form.value = blankForm();
}

function recordToLines(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return Object.entries(value as Record<string, unknown>)
    .map(([key, raw]) => `${key}: ${String(raw)}`)
    .join('\n');
}

/** `KEY: value` 或 `KEY=value` → object；空行忽略。 */
function linesToRecord(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^([^:=]+)\s*[:=]\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    out[match[1]!.trim()] = match[2]!.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 保留平台不建模的字段（type / timeout / 其它私有字段）。 */
function buildConfig(): Record<string, unknown> {
  const original = servers.value.find((server) => server.name === editingName.value)?.config;
  const config: Record<string, unknown> = original ? { ...original } : {};
  for (const key of [
    'command',
    'args',
    'env',
    'url',
    'headers',
    'exposure',
    'toolExposureDefault',
    'description',
    'enabled',
  ]) {
    delete config[key];
  }

  if (form.value.transport === 'stdio') {
    config.command = form.value.command.trim();
    const args = form.value.argsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (args.length > 0) config.args = args;
    const env = linesToRecord(form.value.envText);
    if (env) config.env = env;
  } else {
    config.url = form.value.url.trim();
    const headers = linesToRecord(form.value.headersText);
    if (headers) config.headers = headers;
  }
  if (form.value.exposure !== 'codemode') config.exposure = form.value.exposure;
  if (!form.value.enabled) config.enabled = false;
  if (form.value.description.trim()) config.description = form.value.description.trim();
  return config;
}

async function save(): Promise<void> {
  const name = form.value.name.trim();
  if (!name) {
    toast('server 名字不能为空', 'error');
    return;
  }
  if (form.value.transport === 'stdio' && !form.value.command.trim()) {
    toast('stdio server 需要 command', 'error');
    return;
  }
  if (form.value.transport === 'http' && !form.value.url.trim()) {
    toast('http server 需要 url', 'error');
    return;
  }

  saving.value = true;
  try {
    const payload = { name, config: buildConfig() };
    const isEdit = editingName.value !== null;
    const res = await fetch(
      isEdit ? `/api/config/mcp-servers/${encodeURIComponent(editingName.value!)}` : '/api/config/mcp-servers',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    const body = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `保存失败 (${res.status})`);
    toast(isEdit ? '已更新 server' : '已新增 server', 'success');
    cancelEdit();
    await reloadAfterMutation();
  } catch (err) {
    toast(err instanceof Error ? err.message : '保存失败', 'error');
  } finally {
    saving.value = false;
  }
}

async function remove(server: CatalogServer): Promise<void> {
  const ok = await confirmDelete('MCP server', server.name);
  if (!ok) return;
  try {
    const res = await fetch(`/api/config/mcp-servers/${encodeURIComponent(server.name)}`, {
      method: 'DELETE',
    });
    const body = (await res.json()) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `删除失败 (${res.status})`);
    toast('已删除 server', 'success');
    await reloadAfterMutation();
  } catch (err) {
    toast(err instanceof Error ? err.message : '删除失败', 'error');
  }
}

function exposureHint(value: Exposure): string {
  return EXPOSURES.find((option) => option.value === value)?.hint ?? '';
}

function serverTarget(server: CatalogServer): string {
  const { command, args, url } = server.config;
  if (typeof command === 'string') {
    const rest = Array.isArray(args) ? args.map(String).join(' ') : '';
    return rest ? `${command} ${rest}` : command;
  }
  return typeof url === 'string' ? url : '(未定义)';
}

function toolCountLabel(server: CatalogServer): string {
  const namespace = `mcp__${server.name.replace(/-/g, '_')}__`;
  return namespace;
}
</script>

<template>
  <div class="mcp-page">
    <header class="page-head">
      <div class="page-head-main">
        <h1 class="page-title">MCP</h1>
        <InfoTip :text="PAGE_HINT" />
      </div>
      <button type="button" class="btn-primary" :disabled="showEditor" @click="startCreate">
        <AppIcon name="plus" :size="14" />
        新增 server
      </button>
    </header>

    <p class="catalog-path">
      目录文件：<code>{{ catalogPath || '(未确定)' }}</code>
      <span class="path-hint">pi 同格式，可用 <code>PI_SERVER_MCP_CONFIG</code> 覆盖</span>
    </p>

    <div v-if="conflicts.length > 0" class="notice notice-warn">
      <strong>pi 自己的 mcp.json 也定义了：{{ conflicts.join('、') }}</strong>
      <span>pi 的那份优先生效，这里改不会影响它们。</span>
    </div>

    <div v-if="errors.length > 0" class="notice notice-error">
      <strong>目录里有 {{ errors.length }} 条无法解析的 server</strong>
      <ul>
        <li v-for="error in errors" :key="error">{{ error }}</li>
      </ul>
    </div>

    <section v-if="showEditor" class="editor-card">
      <header class="editor-head">
        <h2>{{ editing ? `编辑 ${editingName}` : '新增 MCP server' }}</h2>
        <button type="button" class="btn-ghost" :disabled="saving" @click="cancelEdit">取消</button>
      </header>

      <div class="form-grid">
        <label class="field">
          <span>名字</span>
          <input v-model="form.name" type="text" placeholder="rea" spellcheck="false" />
          <small>会成为工具命名空间 {{ form.name ? `mcp__${form.name.replace(/-/g, '_')}__*` : 'mcp__<名字>__*' }}</small>
        </label>

        <label class="field">
          <span>传输方式</span>
          <select v-model="form.transport">
            <option value="stdio">stdio（本地进程）</option>
            <option value="http">http（远程）</option>
          </select>
        </label>

        <template v-if="form.transport === 'stdio'">
          <label class="field field-wide">
            <span>command</span>
            <input v-model="form.command" type="text" placeholder="npx" spellcheck="false" />
          </label>
          <label class="field field-wide">
            <span>args（每行一个）</span>
            <textarea v-model="form.argsText" rows="3" spellcheck="false" placeholder="-y&#10;@scope/mcp-server" />
          </label>
          <label class="field field-wide">
            <span>env（每行 <code>KEY=VALUE</code>）</span>
            <textarea v-model="form.envText" rows="3" spellcheck="false" placeholder="API_KEY=xxx" />
          </label>
        </template>

        <template v-else>
          <label class="field field-wide">
            <span>url</span>
            <input v-model="form.url" type="text" placeholder="https://host/mcp" spellcheck="false" />
          </label>
          <label class="field field-wide">
            <span>headers（每行 <code>Key: Value</code>）</span>
            <textarea v-model="form.headersText" rows="3" spellcheck="false" placeholder="Authorization: Bearer xxx" />
          </label>
        </template>

        <label class="field">
          <span>工具暴露方式</span>
          <select v-model="form.exposure">
            <option v-for="option in EXPOSURES" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </select>
          <small>{{ exposureHint(form.exposure) }}</small>
        </label>

        <label class="field">
          <span>状态</span>
          <select v-model="form.enabled">
            <option :value="true">启用</option>
            <option :value="false">停用（目录内保留定义，不参与勾选连接）</option>
          </select>
        </label>

        <label class="field field-wide">
          <span>描述</span>
          <input v-model="form.description" type="text" placeholder="一句话说明这个 server 干什么" />
        </label>
      </div>

      <footer class="editor-foot">
        <span class="editor-hint">保存后新开的会话才会用新定义（已运行的 worker 不热加载）。</span>
        <button type="button" class="btn-primary" :disabled="saving" @click="save">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </footer>
    </section>

    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="servers.length === 0" class="empty">
      目录里还没有 server。点「新增 server」添加，或直接把 pi 的 mcp.json 内容拷进上面的文件。
    </div>

    <div v-else class="server-grid">
      <article v-for="server in servers" :key="server.name" class="server-card">
        <header class="server-head">
          <h2 class="server-name">{{ server.name }}</h2>
          <span class="tag" :class="`tag-${server.exposure}`">{{ server.exposure }}</span>
          <span v-if="conflicts.includes(server.name)" class="tag tag-conflict">pi 优先</span>
          <span v-if="server.config.enabled === false" class="tag tag-off">已停用</span>
        </header>
        <p v-if="server.description" class="server-desc">{{ server.description }}</p>
        <code class="server-target">{{ serverTarget(server) }}</code>
        <code class="server-ns">{{ toolCountLabel(server) }}*</code>
        <footer class="server-foot">
          <button type="button" class="btn-ghost" @click="startEdit(server)">编辑</button>
          <button type="button" class="btn-ghost danger" @click="remove(server)">删除</button>
        </footer>
      </article>
    </div>
  </div>
</template>

<style scoped>
.mcp-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 2px 32px;
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.page-head-main {
  display: flex;
  align-items: center;
  gap: 6px;
}

.page-title {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  color: var(--text);
}

.catalog-path {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.catalog-path code,
.path-hint code {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11.5px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--surface-subtle);
}

.path-hint {
  margin-left: 6px;
  color: var(--text-tertiary);
}

.notice {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 12.5px;
  line-height: 1.5;
}

.notice-warn {
  background: var(--warning-soft);
  border: 1px solid var(--warning);
  color: var(--warning);
}

.notice-error {
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  color: var(--danger);
}

.notice-error ul {
  margin: 0;
  padding-left: 18px;
}

.editor-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.editor-head,
.editor-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.editor-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}

.editor-hint {
  font-size: 12px;
  color: var(--text-tertiary);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary);
}

.field-wide {
  grid-column: 1 / -1;
}

.field input,
.field select,
.field textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 9px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface-subtle);
  color: var(--text);
  font-size: 12.5px;
  font-family: inherit;
}

.field textarea {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  resize: vertical;
}

.field small {
  color: var(--text-tertiary);
  font-size: 11.5px;
  line-height: 1.4;
}

.empty {
  padding: 24px 12px;
  text-align: center;
  font-size: 13px;
  color: var(--text-tertiary);
}

.server-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.server-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  box-shadow: var(--shadow-soft);
}

.server-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.server-name {
  margin: 0;
  font-size: 13.5px;
  font-weight: 650;
}

.tag {
  font-size: 10.5px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--surface-subtle);
  color: var(--text-secondary);
  letter-spacing: 0.02em;
}

.tag-deferred {
  background: var(--accent-soft);
  color: var(--accent-ink);
}

.tag-direct {
  background: var(--success-soft);
  color: var(--success);
}

.tag-hidden,
.tag-off {
  background: var(--surface-subtle);
  color: var(--text-tertiary);
}

.tag-conflict {
  background: var(--warning-soft);
  color: var(--warning);
}

.server-desc {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.server-target,
.server-ns {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11.5px;
  color: var(--text-tertiary);
  overflow-x: auto;
  white-space: nowrap;
}

.server-foot {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

.btn-primary,
.btn-ghost {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border-radius: 6px;
  font-size: 12px;
  padding: 6px 10px;
  cursor: pointer;
}

.btn-primary {
  border: 1px solid transparent;
  background: var(--accent);
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.btn-ghost {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-secondary);
}

.btn-ghost:hover {
  background: var(--surface-subtle);
}

.btn-ghost.danger {
  color: var(--danger);
}
</style>
