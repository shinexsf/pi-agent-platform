<script setup lang="ts">
/**
 * NotificationsConfigView — 配置 / 通知渠道 (change: trigger-scheduling).
 *
 * 渠道定义只存一份：`~/.pi/server/notifications.json`（与 mcp.json 同风格）。
 * 通知本体（收件箱）在 `/notifications`；本页只管「往哪儿推」。
 * 模板只支持三个占位符 —— `{{title}}` / `{{body}}` / `{{severity}}`，URL 编码替换。
 */
import { computed, onMounted, ref } from 'vue';
import AppIcon from '../../components/ui/AppIcon.vue';
import { confirmDialog, toast } from '../../composables/useFeedback';

interface Channel {
  name: string;
  urlTemplate: string;
  method?: 'GET' | 'POST';
  bodyTemplate?: string;
  minSeverity?: 'info' | 'warning' | 'error';
}

const SEVERITIES = ['info', 'warning', 'error'] as const;
const BODY_PLACEHOLDER = '{"text": "{{title}}\\n{{body}}"}';
/** 占位符字面量（模板里直接写双花括号会被 Vue 当成插值，所以放脚本里）。 */
const PH_TITLE = '{{title}}';
const PH_BODY = '{{body}}';
const PH_SEVERITY = '{{severity}}';
const URL_PLACEHOLDER = 'https://…/{{title}}/{{body}}';

const PRESETS: Array<{ label: string; hint: string; template: string }> = [
  {
    label: 'Bark',
    hint: 'iOS 推送',
    template: 'https://api.day.app/<device-key>/{{title}}/{{body}}?group=pi&level={{severity}}',
  },
  {
    label: 'ntfy',
    hint: '自建/公共 ntfy',
    template: 'https://ntfy.sh/<topic>?title={{title}}&message={{body}}&priority=3',
  },
  {
    label: 'PushPlus',
    hint: '微信推送',
    template: 'https://www.pushplus.plus/send?token=<token>&title={{title}}&content={{body}}',
  },
  {
    label: '企业微信机器人',
    hint: '群机器人 webhook（POST）',
    template: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<key>',
  },
];

const channels = ref<Channel[]>([]);
const minSeverity = ref<'info' | 'warning' | 'error'>('info');
const configPath = ref('');
const exists = ref(false);
const loading = ref(true);
const saving = ref(false);
const testing = ref<number | null>(null);

const dirty = ref(false);

async function load() {
  loading.value = true;
  try {
    const res = await fetch('/api/config/notifications');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      path: string;
      exists: boolean;
      minSeverity: string;
      channels: Channel[];
    };
    configPath.value = data.path;
    exists.value = data.exists;
    minSeverity.value = (SEVERITIES as readonly string[]).includes(data.minSeverity)
      ? (data.minSeverity as 'info' | 'warning' | 'error')
      : 'info';
    channels.value = (data.channels ?? []).map((c) => ({ ...c }));
    dirty.value = false;
  } catch (err) {
    toast((err as Error).message, 'error');
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function addChannel(label?: string, template?: string) {
  channels.value.push({
    name: label ?? `channel-${channels.value.length + 1}`,
    urlTemplate: template ?? '',
    method: 'GET',
    minSeverity: 'info',
  });
  dirty.value = true;
}

function addPreset(preset: (typeof PRESETS)[number]) {
  addChannel(preset.label, preset.template);
}

async function removeChannel(index: number) {
  const ch = channels.value[index];
  const ok = await confirmDialog({
    title: '删除渠道',
    message: `确定删除「${ch?.name ?? ''}」？通知仍会落库，只是不再推送。`,
    confirmText: '删除',
    destructive: true,
  });
  if (!ok) return;
  channels.value.splice(index, 1);
  dirty.value = true;
}

async function save() {
  saving.value = true;
  try {
    const res = await fetch('/api/config/notifications', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ minSeverity: minSeverity.value, channels: channels.value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    toast('通知渠道已保存', 'success');
    dirty.value = false;
    await load();
  } catch (err) {
    toast((err as Error).message, 'error');
  } finally {
    saving.value = false;
  }
}

async function testChannel(index: number) {
  testing.value = index;
  try {
    const res = await fetch('/api/config/notifications/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: channels.value[index] }),
    });
    const data = (await res.json()) as { ok: boolean; status?: number; error?: string };
    if (data.ok) toast(`渠道可用（HTTP ${data.status}）`, 'success');
    else toast(`测试失败：${data.error ?? `HTTP ${data.status}`}`, 'error');
  } catch (err) {
    toast((err as Error).message, 'error');
  } finally {
    testing.value = null;
  }
}

const channelCount = computed(() => channels.value.length);
</script>

<template>
  <section class="config-section">
    <div class="section-heading">
      <div>
        <h2 class="section-title">通知渠道</h2>
        <p class="section-hint">
          通知总是先落库（<code>/notifications</code> 收件箱），再按这里的渠道推送。没有渠道时只落库。
          渠道 = 一条 URL 模板，支持 <code>{{ PH_TITLE }}</code> / <code>{{ PH_BODY }}</code> /
          <code>{{ PH_SEVERITY }}</code> 三个占位符。
        </p>
      </div>
      <div class="section-actions">
        <button class="btn btn-primary" type="button" :disabled="saving || !dirty" @click="save">
          保存
        </button>
      </div>
    </div>

    <div v-if="loading" class="loading-caption">加载中…</div>

    <template v-else>
      <div class="surface-panel">
        <div class="panel-toolbar">
          <div class="panel-toolbar-group">
            <label class="inline-field">
              最低级别
              <select v-model="minSeverity" class="control" @change="dirty = true">
                <option v-for="sev in SEVERITIES" :key="sev" :value="sev">{{ sev }}</option>
              </select>
            </label>
            <span class="muted">{{ channelCount }} 个渠道</span>
          </div>
          <div class="panel-toolbar-group">
            <span class="muted mono">{{ configPath }}{{ exists ? '' : '（尚未创建）' }}</span>
          </div>
        </div>

        <div v-if="channels.length === 0" class="empty-state">
          <p>还没有渠道 —— 通知只会出现在收件箱里。</p>
          <div class="preset-row">
            <button
              v-for="preset in PRESETS"
              :key="preset.label"
              type="button"
              class="preset-btn"
              @click="addPreset(preset)"
            >
              <strong>{{ preset.label }}</strong>
              <span>{{ preset.hint }}</span>
            </button>
          </div>
        </div>

        <ul v-else class="channel-list">
          <li v-for="(channel, index) in channels" :key="index" class="channel-row">
            <div class="channel-fields">
              <label class="field">
                <span>名称</span>
                <input v-model="channel.name" class="control" @input="dirty = true" />
              </label>
              <label class="field field-severity">
                <span>最低级别</span>
                <select v-model="channel.minSeverity" class="control" @change="dirty = true">
                  <option v-for="sev in SEVERITIES" :key="sev" :value="sev">{{ sev }}</option>
                </select>
              </label>
              <label class="field field-method">
                <span>方法</span>
                <select v-model="channel.method" class="control" @change="dirty = true">
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                </select>
              </label>
            </div>
            <label class="field">
              <span>URL 模板</span>
              <input
                v-model="channel.urlTemplate"
                class="control mono"
                :placeholder="URL_PLACEHOLDER"
                @input="dirty = true"
              />
            </label>
            <label v-if="channel.method === 'POST'" class="field">
              <span>JSON body 模板（可选）</span>
              <input
                v-model="channel.bodyTemplate"
                class="control mono"
                :placeholder="BODY_PLACEHOLDER"
                @input="dirty = true"
              />
            </label>
            <div class="channel-actions">
              <button
                class="btn btn-secondary btn-sm"
                type="button"
                :disabled="testing === index"
                @click="testChannel(index)"
              >
                {{ testing === index ? '测试中…' : '测试' }}
              </button>
              <button class="btn btn-danger btn-sm" type="button" @click="removeChannel(index)">
                删除
              </button>
            </div>
          </li>
        </ul>
      </div>

      <div class="add-row">
        <button class="btn btn-secondary" type="button" @click="addChannel()">
          <AppIcon name="plus" :size="15" />
          添加渠道
        </button>
        <span class="muted">或者从预设开始：</span>
        <button
          v-for="preset in PRESETS"
          :key="preset.label"
          type="button"
          class="preset-btn preset-btn--inline"
          @click="addPreset(preset)"
        >
          {{ preset.label }}
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.config-section {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.section-title {
  margin: 0 0 6px;
  font-size: 1.12rem;
}

.section-hint {
  max-width: 76ch;
  margin: 0;
  color: var(--text-tertiary);
  font-size: 0.84rem;
  line-height: 1.6;
}

.section-actions {
  flex: 0 0 auto;
}

.panel-toolbar-group {
  display: flex;
  align-items: center;
  gap: 12px;
}

.inline-field {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--text-secondary);
  font-size: 0.82rem;
}

.channel-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}

.channel-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border-bottom: 1px solid var(--border-subtle);
}

.channel-fields {
  display: grid;
  gap: 10px;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 0.8fr);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--text-secondary);
  font-size: 0.8rem;
}

.channel-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.empty-state {
  padding: 26px 18px;
  color: var(--text-tertiary);
  font-size: 0.86rem;
  text-align: center;
}

.preset-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
  margin-top: 14px;
}

.preset-btn {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.76rem;
  text-align: left;
}

.preset-btn strong {
  color: var(--text);
  font-size: 0.84rem;
}

.preset-btn--inline {
  flex-direction: row;
  padding: 5px 12px;
  border-radius: 999px;
}

.add-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.muted {
  color: var(--text-tertiary);
  font-size: 0.8rem;
}

.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  font-size: 0.78rem;
}

.loading-caption {
  padding: 18px;
  color: var(--text-tertiary);
  font-size: 0.84rem;
}

@media (max-width: 900px) {
  .channel-fields {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
