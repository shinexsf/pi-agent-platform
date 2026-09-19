<script setup lang="ts">
/**
 * ListEditor — 「资源列表 + 内容编辑」通用原语。
 *
 * 合并改造前 `SkillsConfig.vue` 与 `PromptsConfig.vue` 两套几乎完全相同的
 * master-detail 实现（design.md D10：section 导航在抽屉，视图内不再有侧栏）。
 *
 * 路由驱动：
 *   `/{basePath}`          → 列表 + 空详情提示（桌面）／仅列表（紧凑）
 *   `/{basePath}/:name`    → 列表 + 该条内容（桌面）／仅内容 + 返回条（紧凑）
 *
 * 紧凑断点下降级为只读（spec app-layout「长文本编辑降级」）——移动端全屏
 * textarea 编辑长文本体验差，显式降级优于勉强可用。
 */
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '../../ui/AppIcon.vue';
import SplitPane from './SplitPane.vue';
import { useIsCompact } from '../../../composables/useMediaQuery';
import { confirmDelete, toast } from '../../../composables/useFeedback';

interface ResourceItem {
  name: string;
}

const props = defineProps<{
  /** 后端资源名，决定 API 前缀 `/api/config/{resource}` */
  resource: 'skills' | 'prompts';
  title: string;
  /** 用于提示与确认文案，如 'Skill' / 'Prompt' */
  entityLabel: string;
  /** 列表路由，如 '/config/skills' */
  basePath: string;
  /** 新建路由，如 '/config/skills/new' */
  newPath: string;
  /** 内容编辑器占位文案 */
  placeholder?: string;
}>();

const route = useRoute();
const router = useRouter();
const isCompact = useIsCompact();

const items = ref<ResourceItem[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);
const content = ref('');
const contentLoading = ref(false);
const editing = ref(false);
const saving = ref(false);

const apiBase = computed(() => `/api/config/${props.resource}`);

/** 当前激活项来自路由参数（`null` 表示列表态）。 */
const activeName = computed<string | null>(() => {
  const raw = route.params.name;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value ? value : null;
});

/** 紧凑断点：编辑能力降级为只读 */
const readOnly = computed(() => isCompact.value);
const canEdit = computed(() => !readOnly.value);

async function loadList(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const res = await fetch(apiBase.value);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    items.value = (await res.json()) as ResourceItem[];
  } catch (err) {
    loadError.value = '加载失败，请检查服务端连接。';
    console.error(`[config] failed to load ${props.resource}:`, err);
  } finally {
    loading.value = false;
  }
}

async function loadContent(name: string): Promise<void> {
  contentLoading.value = true;
  try {
    const res = await fetch(`${apiBase.value}/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { content?: string };
    content.value = data.content ?? '';
  } catch (err) {
    content.value = '';
    toast(`加载 ${props.entityLabel} 内容失败`);
    console.error(`[config] failed to load ${props.resource}/${name}:`, err);
  } finally {
    contentLoading.value = false;
  }
}

function selectItem(item: ResourceItem): void {
  if (item.name === activeName.value) return;
  void router.push(`${props.basePath}/${item.name}`);
}

function backToList(): void {
  void router.push(props.basePath);
}

function openCreate(): void {
  void router.push(props.newPath);
}

async function save(): Promise<void> {
  const name = activeName.value;
  if (!name) return;
  saving.value = true;
  try {
    const res = await fetch(`${apiBase.value}/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.value }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    editing.value = false;
    toast('保存成功', 'success');
  } catch (err) {
    toast(`保存失败：${(err as Error).message}`, 'error');
  } finally {
    saving.value = false;
  }
}

async function remove(name: string): Promise<void> {
  const ok = await confirmDelete(props.entityLabel, name);
  if (!ok) return;

  try {
    const res = await fetch(`${apiBase.value}/${encodeURIComponent(name)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (activeName.value === name) backToList();
    await loadList();
    toast(`已删除 ${props.entityLabel}「${name}」`, 'success');
  } catch (err) {
    toast(`删除失败：${(err as Error).message}`, 'error');
  }
}

async function refresh(): Promise<void> {
  await loadList();
  if (activeName.value) await loadContent(activeName.value);
}

defineExpose({ refresh });

watch(
  activeName,
  (name) => {
    editing.value = false;
    if (name) void loadContent(name);
    else content.value = '';
  },
  { immediate: true },
);

void loadList();
</script>

<template>
  <div class="list-editor">
    <header class="list-editor__head">
      <h2 class="list-editor__title">{{ title }}</h2>
      <div class="list-editor__actions">
        <button type="button" class="btn btn-primary" @click="openCreate">
          + 新建 {{ entityLabel }}
        </button>
        <slot name="actions" />
      </div>
    </header>

    <SplitPane
      :detail-open="activeName !== null"
      :back-label="title"
      @back="backToList"
    >
      <template #list>
        <div v-if="loading" class="list-editor__state">加载中...</div>
        <div v-else-if="loadError" class="list-editor__state">{{ loadError }}</div>
        <div v-else-if="items.length === 0" class="list-editor__state">
          暂无 {{ entityLabel }}
        </div>
        <div v-else class="list-editor__list">
          <div
            v-for="item in items"
            :key="item.name"
            class="list-editor__item"
            :class="{ 'is-active': activeName === item.name }"
          >
            <button type="button" class="list-editor__item-btn" @click="selectItem(item)">
              {{ item.name }}
            </button>
            <button
              type="button"
              class="list-editor__delete"
              :title="`删除 ${item.name}`"
              :aria-label="`删除 ${item.name}`"
              @click.stop="remove(item.name)"
            >
              <AppIcon name="trash" :size="15" />
            </button>
          </div>
        </div>
      </template>

      <template #detail>
        <div v-if="!activeName" class="list-editor__state list-editor__state--center">
          选择一个 {{ entityLabel }} 查看内容
        </div>
        <template v-else>
          <div class="list-editor__detail-head">
            <h3 class="list-editor__detail-title">{{ activeName }}</h3>
            <div class="list-editor__detail-actions">
              <button
                v-if="canEdit && !editing"
                type="button"
                class="btn btn-secondary btn-sm"
                @click="editing = true"
              >
                编辑
              </button>
              <template v-else-if="canEdit">
                <button type="button" class="btn btn-secondary btn-sm" @click="editing = false">
                  取消
                </button>
                <button
                  type="button"
                  class="btn btn-primary btn-sm"
                  :disabled="saving"
                  @click="save"
                >
                  {{ saving ? '保存中...' : '保存' }}
                </button>
              </template>
            </div>
          </div>

          <p v-if="readOnly" class="list-editor__hint">
            移动端为只读预览，请在桌面端编辑。
          </p>

          <textarea
            v-model="content"
            class="list-editor__editor"
            :readonly="!editing || readOnly"
            :placeholder="contentLoading ? '加载中...' : (placeholder ?? '内容...')"
          />
        </template>
      </template>
    </SplitPane>
  </div>
</template>

<style scoped>
.list-editor {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}

.list-editor__head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.list-editor__title {
  min-width: 0;
  margin: 0;
  color: var(--text);
  font-size: 0.95rem;
  font-weight: 700;
}

.list-editor__actions {
  display: flex;
  flex: none;
  gap: 10px;
}

.list-editor__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.list-editor__item {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border);
}

.list-editor__item.is-active {
  background: var(--accent-soft);
}

.list-editor__item-btn {
  min-width: 0;
  flex: 1;
  min-height: 36px;
  padding: 8px 12px;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 0.86rem;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.list-editor__item-btn:hover {
  background: var(--surface-hover);
}

.list-editor__item.is-active .list-editor__item-btn {
  color: var(--accent-ink);
  font-weight: 650;
}

.list-editor__delete {
  display: inline-flex;
  width: 32px;
  height: 32px;
  flex: none;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.list-editor__delete:hover {
  color: var(--danger);
}

.list-editor__detail-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.list-editor__detail-title {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--text);
  font-size: 0.98rem;
  font-weight: 680;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list-editor__detail-actions {
  display: flex;
  flex: none;
  gap: 8px;
}

.list-editor__hint {
  flex: none;
  margin: 0;
  padding: 6px 12px;
  background: var(--warning-soft);
  color: var(--warning);
  font-size: 0.78rem;
}

.list-editor__editor {
  flex: 1;
  min-height: 0;
  width: 100%;
  padding: 10px;
  border: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 0.86rem;
  line-height: 1.65;
  resize: none;
  white-space: pre-wrap;
  word-wrap: break-word;
  box-sizing: border-box;
}

.list-editor__editor:focus {
  outline: none;
}

.list-editor__editor:read-only {
  background: var(--surface);
}

.list-editor__state {
  padding: 20px 16px;
  color: var(--text-secondary);
  font-size: 0.85rem;
  text-align: center;
}

.list-editor__state--center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

@media (max-width: 767px) {
  .list-editor__head {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }

  .list-editor__actions {
    width: 100%;
  }

  .list-editor__actions .btn {
    min-height: 44px;
    flex: 1;
  }
}
</style>
