<script setup lang="ts">
/**
 * PromptsConfig — Prompts 分区。
 *
 * 与 `SkillsConfig` 共用 `ListEditor` 原语，本组件无需额外逻辑。
 */
import ListEditor from '../../components/layout/primitives/ListEditor.vue';
</script>

<template>
  <ListEditor
    resource="prompts"
    title="Prompts 管理"
    entity-label="Prompt"
    base-path="/config/prompts"
    new-path="/config/prompts/new"
    placeholder="Prompt 内容..."
  />
</template>
