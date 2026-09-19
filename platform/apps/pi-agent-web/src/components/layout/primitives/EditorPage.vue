<script setup lang="ts">
/**
 * EditorPage — 内容型编辑器路由页的通用外壳。
 *
 * 替代改造前的居中弹框（`.dialog-overlay` / `.modal-backdrop`）。提供：
 *   - 返回 / 取消（不提交，返回上一页）
 *   - 保存（提交，成功后由页面自行 `router.push` 回列表）
 *   - 移动端全屏（纵向撑满，底部操作条常驻）
 *
 * 契约（spec route-based-modals）：取消 MUST 不发起写请求；浏览器返回键 MUST 丢弃未提交数据。
 */
import { useRouter } from 'vue-router';
import AppIcon from '../../ui/AppIcon.vue';

const props = withDefaults(
  defineProps<{
    title: string;
    /** 取消时的兜底跳转目标（无历史可返回时使用） */
    cancelTo: string;
    saveLabel?: string;
    saving?: boolean;
    canSave?: boolean;
    backLabel?: string;
  }>(),
  {
    saveLabel: '保存',
    saving: false,
    canSave: true,
    backLabel: '返回',
  },
);

const emit = defineEmits<{ (event: 'save'): void }>();

const router = useRouter();

/**
 * 取消 / 返回：优先走浏览器历史（保留用户来源），
 * 深链进入（无历史）时回落到 `cancelTo`。
 */
function goBack(): void {
  const state = window.history.state as { back?: string | null } | null;
  if (state && state.back !== null && state.back !== undefined) {
    router.back();
    return;
  }
  void router.push(props.cancelTo);
}
</script>

<template>
  <div class="editor-page">
    <header class="editor-page__header">
      <button type="button" class="editor-page__back" @click="goBack">
        <AppIcon name="arrow-left" :size="16" />
        <span>{{ backLabel }}</span>
      </button>
      <h2 class="editor-page__title">{{ title }}</h2>
      <div class="editor-page__extra">
        <slot name="actions" />
      </div>
    </header>

    <div class="editor-page__body">
      <slot />
    </div>

    <footer class="editor-page__footer">
      <button type="button" class="btn btn-secondary" @click="goBack">取消</button>
      <button
        type="button"
        class="btn btn-primary"
        :disabled="saving || !canSave"
        @click="emit('save')"
      >
        {{ saving ? '保存中...' : saveLabel }}
      </button>
    </footer>
  </div>
</template>

<style scoped>
.editor-page {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}

.editor-page__header {
  display: flex;
  flex: none;
  align-items: center;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
}

.editor-page__back {
  display: inline-flex;
  min-height: 40px;
  flex: none;
  align-items: center;
  gap: 7px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface-subtle);
  color: var(--text-secondary);
  font-size: 0.82rem;
  font-weight: 650;
  cursor: pointer;
}

.editor-page__back:hover {
  border-color: var(--border-strong);
  background: var(--surface-hover);
  color: var(--text);
}

.editor-page__title {
  min-width: 0;
  flex: 1;
  margin: 0;
  overflow: hidden;
  color: var(--text);
  font-size: 1.05rem;
  font-weight: 720;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-page__extra {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}

.editor-page__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 2px;
}

.editor-page__footer {
  display: flex;
  flex: none;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}

@media (max-width: 767px) {
  .editor-page__back {
    min-height: 44px;
  }

  .editor-page__footer {
    padding-bottom: env(safe-area-inset-bottom);
  }

  .editor-page__footer .btn {
    min-height: 44px;
    flex: 1;
  }
}
</style>
