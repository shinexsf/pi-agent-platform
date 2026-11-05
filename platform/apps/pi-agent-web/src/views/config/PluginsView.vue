<script setup lang="ts">
/**
 * PluginsView — 平台插件目录（config/plugins，change: platform-plugins-catalog）。
 *
 * 只读视图：安装/卸载/启停只能走 `pi-server plugin`，这里只负责把"装了什么、声明了什么、
 * 依赖装没装、为什么没生效"讲清楚，并给出对应的 CLI 命令。
 *
 * 刻意不做的两件事（见 design.md）：
 * - 不提供启停开关（HTTP 层只读）
 * - 不展示"哪些 agent 启用了它"（一个插件可以有多个功能，并非所有功能都依赖 agent 配置）
 *
 * 扩展点是**四态**而不是一个布尔：声明（目录）/ 开关（registry）/ 入口（文件）/ 装载（平台支持）。
 * 合并成一个勾会直接制造"配置对了但不生效"的错觉。
 */
import { computed, onMounted, ref } from 'vue';
import type {
  FacetEntryPointDTO,
  FacetSupport,
  GetPluginDetailResponse,
  ListPluginsResponse,
  PluginDependencyDTO,
  PluginDetailDTO,
  PluginEntryDTO,
  PluginExtensionsResponse,
} from '@pi-agent-platform/api-types';
import type { PluginExtensions, PluginFacetName } from '@pi-agent-platform/plugin-types';
import AppIcon from '../../components/ui/AppIcon.vue';
import InfoTip from '../../components/ui/InfoTip.vue';
import { toast } from '../../composables/useFeedback';

const PAGE_HINT =
  '平台插件：装在 ~/.pi/server/plugins 的插件包，通过 facet 约定向平台贡献能力。' +
  '本页只读——安装/启停/卸载走 pi-server plugin 命令（见底部命令）。' +
  '状态是静态检查结果：运行期是否真的加载成功，要看会话的调试信息。';

const FACET_LABEL: Record<PluginFacetName, string> = {
  server: 'server',
  worker: 'worker',
  extension: 'extension',
  web: 'web',
};

const FACET_ORDER: PluginFacetName[] = ['server', 'worker', 'extension', 'web'];

/** facet 的展示状态：把四个事实压成一句人话，但不丢信息（详情里仍分列）。 */
type FacetBadge = 'ready' | 'declared-only' | 'off' | 'broken' | 'absent' | 'unregistered';

const plugins = ref<PluginEntryDTO[]>([]);
const pluginsDir = ref('');
const facetSupport = ref<Record<PluginFacetName, FacetSupport>>({} as Record<PluginFacetName, FacetSupport>);
const disabledByFlag = ref(false);
const loading = ref(false);
const loadError = ref('');

const detail = ref<PluginDetailDTO | null>(null);
const detailError = ref('');
const detailLoading = ref(false);

const STATUS_LABEL: Record<string, string> = {
  active: 'active',
  degraded: 'degraded',
  disabled: 'disabled',
  pending: 'pending',
  orphan: 'orphan',
};

const STATUS_HINT: Record<string, string> = {
  active: '静态检查通过；运行期是否加载成功见会话调试信息',
  degraded: '能扫描到但不可完整加载，原因见下方',
  disabled: '已在 registry 中停用（任何 facet 都不加载）',
  pending: '变更待下次 spawn 生效',
  orphan: '目录存在但未登记（用 pi-server plugin add 重新登记）',
};

function badgeOf(plugin: PluginEntryDTO, facet: PluginFacetName): FacetBadge {
  const declared = plugin.declaredFacets.includes(facet);
  if (!declared) return 'absent';
  // 未登记 / 整包停用：什么都不加载，先说这件事，别让人以为是单 facet 的问题
  if (plugin.status === 'orphan') return 'unregistered';
  if (plugin.status === 'disabled' || plugin.switches[facet] === false) return 'off';
  if (!plugin.entries?.[facet]?.exists) return 'broken';
  if (facetSupport.value[facet] === 'declared-only') return 'declared-only';
  return 'ready';
}

function badgeText(badge: FacetBadge): string {
  switch (badge) {
    case 'ready':
      return '✓';
    case 'declared-only':
      return '未装载';
    case 'off':
      return '已关';
    case 'broken':
      return '入口缺失';
    case 'unregistered':
      return '未登记';
    default:
      return '—';
  }
}

function badgeTitle(plugin: PluginEntryDTO, facet: PluginFacetName, badge: FacetBadge): string {
  const declared = plugin.declaredFacets.includes(facet);
  const switchedOn = plugin.switches[facet] !== false;
  const support = facetSupport.value[facet];
  const lines = [
    `声明：${declared ? '有目录' : '无目录'}`,
    `开关：${switchedOn ? '开' : '关'}`,
    `装载：${support === 'loaded' ? '平台会执行' : '平台尚未实现装载（仅声明）'}`,
  ];
  if (plugin.status === 'orphan') lines.push('整包未在 registry 登记');
  if (plugin.status === 'disabled') lines.push('整包已停用');
  if (badge === 'broken') lines.push('入口文件缺失（详情里看期望路径）');
  return lines.join(' · ');
}

const dependencySummary = computed(() => (plugin: PluginEntryDTO): string => {
  const entries = Object.entries(plugin.requires ?? {});
  if (entries.length === 0) return '无';
  return entries.map(([name, range]) => `${name} ${range}`).join('、');
});

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    const res = await fetch('/api/plugins');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as ListPluginsResponse;
    plugins.value = body.plugins;
    pluginsDir.value = body.pluginsDir;
    facetSupport.value = body.facetSupport;
    disabledByFlag.value = body.disabledByFlag;
  } catch (err) {
    loadError.value = String(err);
  } finally {
    loading.value = false;
  }
}

async function rescan(): Promise<void> {
  try {
    await fetch('/api/plugins/reload');
    await load();
    toast('已重新扫描插件目录');
  } catch (err) {
    toast(`重新扫描失败：${String(err)}`);
  }
}

/**
 * 运行期注册项（与静态详情分开拉）：静态接口只说"装了什么"，
 * 这个接口说"跑起来之后声明了什么"——含被拒项与注册错误。
 */
const extensions = ref<PluginExtensions | null>(null);

async function openDetail(id: string): Promise<void> {
  detailLoading.value = true;
  detailError.value = '';
  detail.value = null;
  extensions.value = null;
  try {
    const [detailRes, extRes] = await Promise.all([
      fetch(`/api/plugins/${encodeURIComponent(id)}`),
      fetch(`/api/plugins/${encodeURIComponent(id)}/extensions`),
    ]);
    if (!detailRes.ok) throw new Error(`HTTP ${detailRes.status}`);
    const body = (await detailRes.json()) as GetPluginDetailResponse;
    detail.value = body.detail;
    if (extRes.ok) {
      const ext = (await extRes.json()) as PluginExtensionsResponse;
      extensions.value = ext.extensions;
    }
  } catch (err) {
    detailError.value = String(err);
  } finally {
    detailLoading.value = false;
  }
}

/** 已注册的界面贡献（菜单 / 页面 / 槽位 / 工具卡片）。 */
const contributedUi = computed(() => {
  const ext = extensions.value;
  if (!ext) return [];
  const rows: Array<{ kind: string; id: string; detail: string }> = [];
  for (const menu of ext.menus) {
    rows.push({ kind: '菜单', id: menu.id, detail: `${menu.label}${menu.parent ? ` → ${menu.parent}` : ''} → page:${menu.page}` });
  }
  for (const page of ext.pages) rows.push({ kind: '页面', id: page.id, detail: page.entry });
  for (const surface of ext.surfaces) rows.push({ kind: '槽位', id: surface.id, detail: `${surface.slot} · ${surface.title} · web/${surface.entry}.js` });
  for (const tool of ext.toolCards) {
    const desc = tool.mode === 'replace'
      ? `整卡替换 → web/${tool.entry}.js`
      : `区域替换 ${Object.keys(tool.regions ?? {}).join('/')}`;
    rows.push({ kind: '工具卡片', id: tool.tool, detail: `${tool.match ?? 'exact'} · ${desc}` });
  }
  const pluginId = detail.value?.plugin.id ?? '';
  for (const route of ext.routes) {
    rows.push({ kind: 'HTTP', id: `${route.method} /api/p/${pluginId}${route.path}`, detail: '' });
  }
  return rows;
});

function closeDetail(): void {
  detail.value = null;
  detailError.value = '';
}

function entryOf(facet: PluginFacetName): FacetEntryPointDTO | undefined {
  return detail.value?.entryPoints?.[facet];
}

function dependencyStatus(dep: PluginDependencyDTO): { text: string; tone: string; hint: string } {
  if (dep.installed === true) {
    const via = dep.via === 'settings' ? 'settings.json' : 'node_modules';
    return {
      text: `✓ 已安装${dep.version ? ` v${dep.version}` : ''}`,
      tone: 'ok',
      hint: via,
    };
  }
  if (dep.installed === null) {
    return { text: '? 未知', tone: 'unknown', hint: 'pi 的 settings.json 读不出来，无法判定' };
  }
  return { text: '✗ 未安装', tone: 'bad', hint: '按 pi-server plugin 手册安装后再启用该插件' };
}

function copyCommand(text: string): void {
  void navigator.clipboard?.writeText(text).then(
    () => toast('已复制'),
    () => toast(text),
  );
}

const commands = computed(() => {
  const id = detail.value?.plugin.id ?? '<id>';
  return [
    { label: '安装', cmd: `pi-server plugin add <dir> --enable` },
    { label: '停用', cmd: `pi-server plugin disable ${id}` },
    { label: '启用', cmd: `pi-server plugin enable ${id}` },
    { label: '卸载', cmd: `pi-server plugin remove ${id}` },
  ];
});

onMounted(load);
</script>

<template>
  <section class="plugins-view">
    <header class="page-head">
      <h1 class="page-title">
        平台插件
        <InfoTip :text="PAGE_HINT" :width="360" />
      </h1>
      <div class="head-actions">
        <span v-if="pluginsDir" class="plugins-dir" :title="pluginsDir">{{ pluginsDir }}</span>
        <button type="button" class="btn-ghost" :disabled="loading" @click="rescan">
          {{ loading ? '扫描中…' : '重新扫描' }}
        </button>
      </div>
    </header>

    <p v-if="disabledByFlag" class="banner banner-warn">
      插件已被环境变量 <code>PI_PLUGINS=0</code> 全局关闭，所有插件都不会加载。
    </p>
    <p v-if="loadError" class="banner banner-error">读取插件目录失败：{{ loadError }}</p>

    <div v-if="!loading && plugins.length === 0 && !loadError" class="empty">
      <p class="empty-title">还没有安装平台插件</p>
      <p class="empty-hint">
        安装：<code>pi-server plugin add &lt;dir&gt; --enable</code>
      </p>
      <p class="empty-hint">插件目录：{{ pluginsDir }}</p>
    </div>

    <ul v-else class="plugin-list">
      <li
        v-for="plugin in plugins"
        :key="plugin.id"
        class="plugin-card"
        :class="`is-${plugin.status}`"
        @click="openDetail(plugin.id)"
      >
        <div class="card-head">
          <span class="plugin-id">{{ plugin.id }}</span>
          <span class="plugin-version">{{ plugin.version }}</span>
          <span class="status-pill" :class="`status-${plugin.status}`">
            {{ STATUS_LABEL[plugin.status] ?? plugin.status }}
            <InfoTip :text="STATUS_HINT[plugin.status] ?? ''" :width="260" />
          </span>
        </div>

        <p v-if="plugin.description" class="plugin-desc">{{ plugin.description }}</p>

        <div class="card-meta">
          <div class="facet-row">
            <span
              v-for="facet in FACET_ORDER"
              :key="facet"
              class="facet-badge"
              :class="[`facet-${badgeOf(plugin, facet)}`]"
              :title="badgeTitle(plugin, facet, badgeOf(plugin, facet))"
            >
              <span class="facet-name">{{ FACET_LABEL[facet] }}</span>
              <span class="facet-state">{{ badgeText(badgeOf(plugin, facet)) }}</span>
            </span>
          </div>
          <span class="dep-summary">依赖：{{ dependencySummary(plugin) }}</span>
        </div>

        <p v-if="plugin.reason" class="plugin-reason">{{ plugin.reason }}</p>
      </li>
    </ul>

    <!-- 详情 -->
    <div v-if="detail || detailLoading || detailError" class="detail-backdrop" @click.self="closeDetail">
      <div class="detail-panel">
        <header class="detail-head">
          <div>
            <h2 class="detail-title">{{ detail?.plugin.id ?? '加载中…' }}</h2>
            <p v-if="detail" class="detail-sub">
              v{{ detail.plugin.version }} · apiVersion {{ detail.plugin.apiVersion ?? '-' }} ·
              <span :class="`status-${detail.plugin.status}`">{{ detail.plugin.status }}</span>
            </p>
          </div>
          <button type="button" class="btn-icon" @click="closeDetail">✕</button>
        </header>

        <p v-if="detailError" class="banner banner-error">读取详情失败：{{ detailError }}</p>

        <template v-if="detail">
          <section class="detail-section">
            <h3>基本信息</h3>
            <dl class="kv">
              <dt>安装目录</dt>
              <dd class="mono">{{ detail.plugin.dir }}</dd>
              <dt>安装时间</dt>
              <dd>{{ detail.plugin.installedAt ?? '-' }}</dd>
              <dt>描述</dt>
              <dd>{{ detail.plugin.description ?? '（插件未声明）' }}</dd>
              <dt v-if="detail.plugin.author">作者</dt>
              <dd v-if="detail.plugin.author">{{ detail.plugin.author }}</dd>
              <dt v-if="detail.plugin.homepage">主页</dt>
              <dd v-if="detail.plugin.homepage" class="mono">{{ detail.plugin.homepage }}</dd>
            </dl>
          </section>

          <section class="detail-section">
            <h3>扩展点</h3>
            <table class="facet-table">
              <thead>
                <tr>
                  <th>facet</th>
                  <th>声明</th>
                  <th>开关</th>
                  <th>入口</th>
                  <th>装载</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="facet in FACET_ORDER" :key="facet">
                  <td class="mono">{{ FACET_LABEL[facet] }}</td>
                  <td>{{ detail.plugin.declaredFacets.includes(facet) ? '有目录' : '—' }}</td>
                  <td>{{ detail.plugin.switches[facet] === false ? '已关' : '开' }}</td>
                  <td class="entry-cell">
                    <template v-if="entryOf(facet)?.exists">
                      <span class="ok">✓</span> <span class="mono">{{ entryOf(facet)?.path }}</span>
                    </template>
                    <template v-else-if="detail.plugin.declaredFacets.includes(facet)">
                      <span class="bad">✗</span>
                      <span class="mono">{{ entryOf(facet)?.candidates.join(' 或 ') }}</span>
                    </template>
                    <span v-else class="muted">—</span>
                  </td>
                  <td>
                    <span v-if="facetSupport[facet] === 'loaded'" class="ok">会执行</span>
                    <span v-else class="warn">已声明·未装载</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section class="detail-section">
            <h3>依赖的 pi 插件</h3>
            <p v-if="detail.dependencies.length === 0" class="muted">未声明依赖</p>
            <ul v-else class="dep-list">
              <li v-for="dep in detail.dependencies" :key="dep.name" class="dep-item">
                <span class="mono">{{ dep.name }}</span>
                <span class="dep-range">{{ dep.range }}</span>
                <span class="dep-state" :class="`dep-${dependencyStatus(dep).tone}`">
                  {{ dependencyStatus(dep).text }}
                  <InfoTip :text="dependencyStatus(dep).hint" :width="240" />
                </span>
              </li>
            </ul>
          </section>

          <section class="detail-section">
            <h3>运行期注册项</h3>
            <p v-if="extensions?.registerError" class="banner banner-error">
              注册失败：{{ extensions.registerError }}
            </p>
            <p v-if="contributedUi.length === 0 && !extensions?.registerError" class="muted">
              未注册任何界面贡献（未装载，或 register() 没有注册内容）
            </p>
            <table v-else-if="contributedUi.length > 0" class="facet-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>id</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in contributedUi" :key="`${row.kind}-${row.id}`">
                  <td>{{ row.kind }}</td>
                  <td class="mono">{{ row.id }}</td>
                  <td class="mono">{{ row.detail }}</td>
                </tr>
              </tbody>
            </table>
            <div v-if="extensions && extensions.rejected.length > 0" class="rejected">
              <h4>被拒绝的注册（{{ extensions.rejected.length }}）</h4>
              <ul>
                <li v-for="(item, index) in extensions.rejected" :key="index">
                  <span class="mono">{{ item.kind }}/{{ item.id }}</span> — {{ item.reason }}
                </li>
              </ul>
            </div>
          </section>

          <section class="detail-section">
            <h3>命令行</h3>
            <ul class="cmd-list">
              <li v-for="item in commands" :key="item.label" class="cmd-item">
                <span class="cmd-label">{{ item.label }}</span>
                <code class="cmd-text">{{ item.cmd }}</code>
                <button type="button" class="btn-ghost btn-mini" @click="copyCommand(item.cmd)">复制</button>
              </li>
            </ul>
            <p class="muted cmd-note">
              本页只读：启用/停用/卸载请用上面的命令（改动 server facet 需重启，worker/extension facet 下次会话生效）。
            </p>
          </section>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.plugins-view {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px 24px 40px;
  min-height: 0;
}

.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.page-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 18px;
  font-weight: 650;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.plugins-dir {
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  color: var(--text-muted, #6b7280);
  max-width: 380px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty {
  border: 1px dashed var(--border, #dfe4ec);
  border-radius: 10px;
  padding: 28px 20px;
  text-align: center;
  color: var(--text-muted, #6b7280);
}

.empty-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text, #111827);
}

.empty-hint {
  margin: 4px 0;
  font-size: 12px;
}

.plugin-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.plugin-card {
  border: 1px solid var(--border, #dfe4ec);
  border-radius: 10px;
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
  background: var(--surface, #fff);
}

.plugin-card:hover {
  border-color: var(--accent, #315fda);
  box-shadow: 0 2px 10px rgb(49 95 218 / 8%);
}

.plugin-card.is-degraded {
  border-left: 3px solid var(--warning, #d97706);
}

.plugin-card.is-disabled,
.plugin-card.is-orphan {
  opacity: 0.75;
}

.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.plugin-id {
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  font-weight: 600;
}

.plugin-version {
  font-size: 11.5px;
  color: var(--text-muted, #6b7280);
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  background: var(--surface-subtle, #eef1f6);
  color: var(--text, #374151);
}

.status-active {
  background: var(--success-soft, #e7f6ec);
  color: var(--success, #15803d);
}

.status-degraded {
  background: var(--warning-soft, #fef3e2);
  color: var(--warning, #b45309);
}

.status-disabled,
.status-orphan {
  background: var(--surface-subtle, #eef1f6);
  color: var(--text-muted, #4b5563);
}

.plugin-desc {
  margin: 6px 0 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--text-muted, #4b5563);
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  margin-top: 10px;
}

.facet-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.facet-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: 5px;
  font-size: 11px;
  border: 1px solid transparent;
}

.facet-name {
  font-family: var(--font-mono, monospace);
  opacity: 0.75;
}

.facet-ready {
  background: var(--success-soft, #e7f6ec);
  border-color: color-mix(in srgb, var(--success, #15803d) 28%, transparent);
  color: var(--success, #15803d);
}

.facet-declared-only {
  background: var(--surface-subtle, #eef1f6);
  border-color: var(--border, #d8dee9);
  color: var(--text-muted, #4b5563);
}

.facet-off {
  background: var(--surface-subtle, #f4f5f7);
  border-color: var(--border, #e3e6ec);
  color: var(--text-muted, #9aa1ae);
  opacity: 0.75;
}

.facet-broken {
  background: var(--danger-soft, #fdeaea);
  border-color: color-mix(in srgb, var(--danger, #b91c1c) 28%, transparent);
  color: var(--danger, #b91c1c);
}

.facet-absent {
  background: transparent;
  border-color: var(--border, #e8ebf0);
  color: var(--text-muted, #b6bcc7);
  opacity: 0.6;
}

.facet-unregistered {
  background: var(--surface-subtle, #f4f5f7);
  border-color: var(--border, #e3e6ec);
  color: var(--text-muted, #6b7280);
}

.dep-summary {
  font-size: 11.5px;
  color: var(--text-muted, #6b7280);
}

.plugin-reason {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--warning, #b45309);
}

.banner {
  margin: 0;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 12.5px;
}

.banner-warn {
  background: var(--warning-soft, #fef3e2);
  color: var(--warning, #92400e);
}

.banner-error {
  background: var(--danger-soft, #fdeaea);
  color: var(--danger, #b91c1c);
}

/* 详情 */
.detail-backdrop {
  /* 顶部让开 app-header：fixed 定位在某些祖先（view-transition 的 transform）下会被
     限制在容器内，直接顶到 header 底下会让关闭按钮点不到。 */
  position: fixed;
  top: var(--app-header-h, 56px);
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 210;
  display: flex;
  justify-content: flex-end;
  background: rgb(15 23 42 / 32%);
}

.detail-panel {
  width: min(720px, 100%);
  height: 100%;
  border-left: 1px solid var(--border, #dfe4ec);
  overflow: auto;
  background: var(--surface, #fff);
  padding: 18px 20px 32px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.detail-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.detail-title {
  margin: 0;
  font-family: var(--font-mono, monospace);
  font-size: 15px;
  font-weight: 650;
}

.detail-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-muted, #6b7280);
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.detail-section h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
}

.kv {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 6px 10px;
  margin: 0;
  font-size: 12.5px;
}

.kv dt {
  color: var(--text-muted, #6b7280);
}

.kv dd {
  margin: 0;
  word-break: break-all;
}

.facet-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.facet-table th,
.facet-table td {
  text-align: left;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border, #eef1f6);
  vertical-align: top;
}

.facet-table th {
  font-weight: 600;
  color: var(--text-muted, #6b7280);
  font-size: 11.5px;
}

.entry-cell {
  word-break: break-all;
}

.dep-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.dep-item {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
}

.dep-range {
  color: var(--text-muted, #6b7280);
  font-size: 11.5px;
}

.dep-state {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
}

.dep-ok {
  color: var(--success, #15803d);
}

.dep-bad {
  color: var(--danger, #b91c1c);
}

.dep-unknown {
  color: var(--warning, #b45309);
}

.cmd-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cmd-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.cmd-label {
  width: 44px;
  color: var(--text-muted, #6b7280);
}

.cmd-text {
  flex: 1;
  font-family: var(--font-mono, monospace);
  background: var(--code-inline-bg, #e2e8f2);
  color: var(--text, inherit);
  border: 1px solid var(--code-border, #d9e0ea);
  padding: 3px 8px;
  border-radius: 5px;
  word-break: break-all;
}

.cmd-note {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--text-muted, #6b7280);
}

.mono {
  font-family: var(--font-mono, monospace);
}

.ok {
  color: var(--success, #15803d);
}

.bad {
  color: var(--danger, #b91c1c);
}

.warn {
  color: var(--warning, #b45309);
}

.muted {
  color: var(--text-muted, #9aa1ae);
}

.btn-ghost {
  border: 1px solid var(--border, #dfe4ec);
  background: var(--surface, #fff);
  border-radius: 7px;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
}

.btn-ghost:hover {
  border-color: var(--accent, #315fda);
  color: var(--accent, #315fda);
}

.btn-mini {
  padding: 2px 8px;
  font-size: 11px;
}

.btn-icon {
  border: none;
  background: transparent;
  font-size: 15px;
  cursor: pointer;
  color: var(--text-muted, #6b7280);
}
</style>
