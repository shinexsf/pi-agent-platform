<script setup lang="ts">
/**
 * 三点按钮 + 下拉菜单。
 *
 * ⚠️ 菜单渲染在 **body 级**（`<Teleport to="body">` + `position: fixed`），而不是
 * 相对 trigger 的 `position: absolute`。
 *
 * 原因：列表容器 `.surface-panel` 是 `overflow: hidden`（为了圆角裁切），旧的
 * absolute 菜单会被祖先直接裁掉 —— 表现为「点三点只露出一条白边」。这类裁剪
 * 在任何祖先上加 `overflow` 都会复现，所以在 body 级渲染是唯一稳的解法。
 * 代价：需要自己算坐标 + 处理「下方空间不够时向上翻」+ 跟随滚动。
 */
import { ref, watch, nextTick, onBeforeUnmount } from 'vue'

const open = ref(false)
const wrapperRef = ref<HTMLElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)

/** 视口坐标（配 `position: fixed`）。 */
const pos = ref({ top: 0, right: 0 })

const GAP = 4
const MARGIN = 8

/**
 * 用 trigger 的 rect 算菜单位置：默认贴 trigger 右缘、向下展开；
 * 下方空间不够（贴着窗口底）且上方放得下时向上翻。
 * 菜单高度要渲染后才知道，所以 [toggle] 里会算两遍。
 */
function computePosition(): void {
  const trigger = wrapperRef.value?.getBoundingClientRect()
  if (!trigger) return
  const vh = window.innerHeight
  const vw = window.innerWidth
  const menuH = menuEl.value?.offsetHeight ?? 0

  let top = trigger.bottom + GAP
  if (menuH > 0 && top + menuH > vh - MARGIN) {
    const above = trigger.top - GAP - menuH
    top = above >= MARGIN ? above : Math.max(MARGIN, vh - MARGIN - menuH)
  }
  pos.value = {
    top: Math.round(top),
    right: Math.round(Math.max(MARGIN, vw - trigger.right)),
  }
}

async function toggle(): Promise<void> {
  open.value = !open.value
  if (!open.value) return
  computePosition()
  await nextTick()
  // 第二遍：拿到真实高度，决定是否需要向上翻
  computePosition()
}

function close(): void {
  open.value = false
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}

function onBackdrop(e: PointerEvent): void {
  const t = e.target as Node
  if (wrapperRef.value?.contains(t)) return
  if (menuEl.value?.contains(t)) return
  close()
}

/** 滚动 / 缩放时跟随 trigger（列表本身可能滚，菜单在 body 级不会自动跟着走）。 */
function onViewportChange(): void {
  if (open.value) computePosition()
}

function onMenuClick(): void {
  // allow click to propagate (menu item handler fires first), then close
  requestAnimationFrame(close)
}

watch(open, (v) => {
  if (v) {
    document.addEventListener('pointerdown', onBackdrop)
    document.addEventListener('keydown', onKeydown)
    document.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
  } else {
    document.removeEventListener('pointerdown', onBackdrop)
    document.removeEventListener('keydown', onKeydown)
    document.removeEventListener('scroll', onViewportChange, true)
    window.removeEventListener('resize', onViewportChange)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onBackdrop)
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
})
</script>

<template>
  <div class="dropdown-wrapper" ref="wrapperRef">
    <button
      class="btn btn-secondary btn-icon dropdown-trigger"
      type="button"
      aria-haspopup="true"
      :aria-expanded="open"
      @click.stop="toggle"
    >
      <slot name="trigger">
        <span class="ellipsis-icon">⋯</span>
      </slot>
    </button>
    <Teleport to="body">
      <Transition name="dd">
        <div
          v-if="open"
          ref="menuEl"
          class="dropdown-menu"
          role="menu"
          :style="{ top: `${pos.top}px`, right: `${pos.right}px` }"
          @click="onMenuClick"
        >
          <slot />
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.dropdown-wrapper {
  position: relative;
  flex: 0 0 auto;
}

.dropdown-trigger {
  min-width: 28px;
  min-height: 28px;
  border: 0 !important;
  background: transparent;
}

.ellipsis-icon {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 2px;
  line-height: 1;
}

/* body 级渲染：不受任何祖先 overflow 裁剪，也不受父级层叠上下文影响 */
.dropdown-menu {
  position: fixed;
  min-width: 140px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  padding: 4px 0;
  z-index: 3000;
}

.dropdown-menu :deep(.dropdown-item) {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: 0.88rem;
  text-align: left;
  cursor: pointer;
  transition: background 120ms;
}

.dropdown-menu :deep(.dropdown-item:hover) {
  background: var(--surface-hover);
}

.dropdown-menu :deep(.dropdown-item.is-danger) {
  color: var(--danger);
}

.dropdown-menu :deep(.dropdown-item.is-danger:hover) {
  background: var(--danger-soft);
}

/* transition */
.dd-enter-active,
.dd-leave-active {
  transition: opacity 120ms ease, transform 120ms ease;
}
.dd-enter-from,
.dd-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
