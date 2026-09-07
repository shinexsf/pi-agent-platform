<script setup lang="ts">
// Keep Archify in its own document so its theme, styles and export tools
// remain independent of the app shell. Vite supplies the hosting prefix.
const diagramUrl = `${import.meta.env.BASE_URL}architecture/viewer.html`;
</script>

<template>
  <iframe
    class="architecture-viewer"
    :src="diagramUrl"
    title="pi-agent-platform 交互式架构图"
    allow="clipboard-write; fullscreen"
  />
</template>

<style scoped>
.architecture-viewer {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: var(--bg);
}
</style>
