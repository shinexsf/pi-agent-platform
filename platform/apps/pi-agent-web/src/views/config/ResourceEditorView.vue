<script setup lang="ts">
/**
 * ResourceEditorView — 「新建 Skill / 新建 Prompt」路由页。
 *
 * 由改造前的居中弹框（`SkillsConfig` / `PromptsConfig` 里的 `.dialog-overlay`）
 * 改为全屏路由页，获得深链、刷新不丢、返回键可用（spec route-based-modals）。
 *
 * 资源类型由路由 `meta.resource` 决定，两处共用同一个组件。
 */
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import EditorPage from '../../components/layout/primitives/EditorPage.vue';
import { toast } from '../../composables/useFeedback';

const route = useRoute();
const router = useRouter();

const resource = computed<'skills' | 'prompts'>(
  () => (route.meta.resource === 'prompts' ? 'prompts' : 'skills'),
);
const entityLabel = computed(() => (resource.value === 'prompts' ? 'Prompt' : 'Skill'));
const basePath = computed(() => `/config/${resource.value}`);

const name = ref('');
const content = ref('');
const saving = ref(false);

const trimmedName = computed(() => name.value.trim());
const canSave = computed(() => trimmedName.value.length > 0);

async function save(): Promise<void> {
  if (!canSave.value || saving.value) return;
  saving.value = true;
  try {
    const res = await fetch(`/api/config/${resource.value}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: trimmedName.value,
        content: content.value || `# ${trimmedName.value}\n\nDescribe your ${entityLabel.value.toLowerCase()} here.\n`,
      }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    toast(`${entityLabel.value}「${trimmedName.value}」已创建`, 'success');
    await router.push(`${basePath.value}/${encodeURIComponent(trimmedName.value)}`);
  } catch (err) {
    toast(`创建失败：${(err as Error).message}`, 'error');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <EditorPage
    :title="`新建 ${entityLabel}`"
    :cancel-to="basePath"
    :can-save="canSave"
    :saving="saving"
    save-label="创建"
    @save="save"
  >
    <div class="resource-editor">
      <label class="field">
        <span class="field-label">名称</span>
        <input
          v-model="name"
          class="control mono"
          type="text"
          autocomplete="off"
          :placeholder="resource === 'prompts' ? 'my-prompt' : 'my-skill'"
        />
      </label>

      <label class="field resource-editor__content">
        <span class="field-label">内容（可选，留空自动生成模板）</span>
        <textarea
          v-model="content"
          class="control mono resource-editor__textarea"
          :placeholder="`# ${trimmedName || (resource === 'prompts' ? 'my-prompt' : 'my-skill')}`"
        />
      </label>
    </div>
  </EditorPage>
</template>

<style scoped>
.resource-editor {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  gap: 16px;
  max-width: 900px;
}

.resource-editor__content {
  flex: 1;
  min-height: 0;
}

.resource-editor__textarea {
  height: 100%;
  min-height: 220px;
  resize: vertical;
  line-height: 1.65;
}
</style>
