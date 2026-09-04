<!--
  ImageGrid — display image blocks for a MessageDTO.
  Used by:
    - <MessageItem> user bubble bottom (variant="user")
    - <MessageItem> tool card result area (variant="tool")
    - <InputBox> pill bar during typing (variant="pill" — omitted; InputBox uses ImagePill directly)

  Both source paths (history → base64 inline via MessageDTO.images / tc.images)
  + (live user → base64 from useAttachments.cache via useSSE.send images param)
  produce the same `{mimeType, data}` shape; this component renders them uniformly.

  Click on any thumbnail opens a fullscreen preview overlay (Teleport to body).
  Click anywhere on the overlay closes it. Escape key also closes.
-->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  images: Array<{ mimeType: string; data: string; sha256?: string }>
  /** "user" sends below the bubble; "tool" inside the tool card backdrop. */
  variant?: 'user' | 'tool'
}>()

const dataUri = computed(() =>
  (img: { mimeType: string; data: string }) => `data:${img.mimeType};base64,${img.data}`,
)

function altLabel(img: { sha256?: string }, i: number): string {
  return img.sha256 ? `image ${img.sha256.slice(0, 7)}` : `image ${i + 1}`
}

// Local preview state. Using Teleport so the overlay covers the whole viewport
// even when nested inside scrollable chat containers.
const previewing = ref<typeof props.images[number] | null>(null)

function open(img: typeof props.images[number]) {
  previewing.value = img
}
function close() {
  previewing.value = null
}

// Close on Escape.
function onOverlayKey(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
}
watch(previewing, (open) => {
  if (open) {
    window.addEventListener('keydown', onOverlayKey)
    document.body.style.overflow = 'hidden'
  } else {
    window.removeEventListener('keydown', onOverlayKey)
    document.body.style.overflow = ''
  }
})
</script>

<template>
  <div
    v-if="images.length > 0"
    class="image-grid"
    :class="`grid-${variant ?? 'user'}`"
  >
    <button
      v-for="(img, i) in images"
      :key="img.sha256 ?? i"
      type="button"
      class="image-tile"
      :title="`${altLabel(img, i)} — click to preview`"
      @click.stop="open(img)"
    >
      <img
        :src="dataUri(img)"
        :alt="altLabel(img, i)"
        loading="lazy"
      />
    </button>
  </div>

  <Teleport to="body">
    <div
      v-if="previewing"
      class="image-preview-overlay"
      role="dialog"
      aria-modal="true"
      @click.self="close"
      @click="close"
    >
      <img
        class="image-preview-fullscreen"
        :src="dataUri(previewing)"
        :alt="altLabel(previewing, 0)"
        @click.stop
      />
      <button
        type="button"
        class="image-preview-close"
        title="Close (Esc)"
        aria-label="Close preview"
        @click.stop="close"
      >×</button>
    </div>
  </Teleport>
</template>

<style scoped>
.image-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 0 0;
  margin-top: 4px;
}

.image-grid.grid-user {
  /* Inside the user bubble; the bubble itself is now the surrounding bg,
     so the grid just sits inside, on top of the bubble's color. */
  max-width: 100%;
  padding-top: 8px;
  /* Tiles should not escape the bubble's rounded corners. */
  overflow: hidden;
  border-radius: 0 0 8px 8px;
}

.image-grid.grid-tool {
  /* Inside the tool-result card backdrop. */
  background: var(--tool-result-bg);
  padding: 6px;
  border-radius: 4px;
  margin-top: 4px;
}

.image-tile {
  display: inline-block;
  width: 96px;
  height: 96px;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--border);
  cursor: zoom-in;
  background: var(--hover-bg);
  transition: transform 0.1s;
  text-decoration: none;
  /* Reset button defaults so the tile doesn't have browser button chrome. */
  padding: 0;
}

.image-tile:hover {
  transform: scale(1.02);
}

.image-tile img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* Fullscreen preview overlay. Teleported to <body> so it covers the
   viewport regardless of where ImageGrid is rendered in the DOM tree. */
:global(.image-preview-overlay) {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: zoom-out;
  animation: preview-fade 0.12s ease-out;
}

@keyframes preview-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}

.image-preview-fullscreen {
  max-width: 92vw;
  max-height: 92vh;
  object-fit: contain;
  cursor: default;
  /* Click stop stops click bubbling to overlay; clicking image
     itself shouldn't close (use ×). */
}

.image-preview-close {
  position: fixed;
  top: 16px;
  right: 20px;
  background: rgba(255, 255, 255, 0.15);
  border: 1px solid rgba(255, 255, 255, 0.4);
  color: white;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  z-index: 10000;
  /* Hover-friendly: solid bg on hover. */
  transition: background 0.12s;
}
.image-preview-close:hover {
  background: rgba(255, 255, 255, 0.4);
}
</style>
