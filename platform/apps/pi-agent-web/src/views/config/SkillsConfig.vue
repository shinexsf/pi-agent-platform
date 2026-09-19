<script setup lang="ts">
/**
 * SkillsConfig — Skills 分区。
 *
 * 列表 + 内容编辑逻辑全部下沉到 `ListEditor` 原语（与 PromptsConfig 共用）；
 * 本组件只提供 Skills 特有的「导入 .md 文件」动作。
 *
 * 导入用隐藏 `<input type="file">` 直接触发原生文件选择器，不再需要自定义弹框
 * （原生选择器本身就是系统级对话框，移动端体验更好）。
 */
import { ref } from 'vue';
import ListEditor from '../../components/layout/primitives/ListEditor.vue';
import { toast } from '../../composables/useFeedback';

const editor = ref<InstanceType<typeof ListEditor> | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const importing = ref(false);

function pickFile(): void {
  fileInput.value?.click();
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  // 立即清空，允许连续导入同一个文件
  input.value = '';
  if (!file) return;

  importing.value = true;
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/config/skills/upload', { method: 'POST', body: form });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    toast('导入成功', 'success');
    await editor.value?.refresh();
  } catch (err) {
    toast(`导入失败：${(err as Error).message}`, 'error');
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <ListEditor
    ref="editor"
    resource="skills"
    title="Skills 管理"
    entity-label="Skill"
    base-path="/config/skills"
    new-path="/config/skills/new"
    placeholder="Skill 内容..."
  >
    <template #actions>
      <input ref="fileInput" type="file" accept=".md" hidden @change="onFileChange" />
      <button type="button" class="btn btn-secondary" :disabled="importing" @click="pickFile">
        {{ importing ? '导入中...' : '导入文件' }}
      </button>
    </template>
  </ListEditor>
</template>
