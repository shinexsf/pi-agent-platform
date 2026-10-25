<script setup lang="ts">
import { computed, ref } from 'vue'
import MarkdownIt, { type Options } from 'markdown-it'
import hljs from 'highlight.js/lib/common'
import { useMermaid } from '../composables/useMermaid'

const props = defineProps<{
  source: string
  /** Extra class names to add to rendered code blocks (used by code-block copy button). */
  codeBlockClassName?: string
}>()

/**
 * Markdown rendering for assistant / thinking / tool result content.
 *
 * Pipeline:
 *   1. Default markdown-it `text` rule (no auto file-path detection — see
 *      history: previous regex `[^\s,，。；;：:]+` over-matched `/api/users`,
 *      `/bin/ls`, URL fragments, etc. into pseudo "tool-file-link"s that the
 *      user couldn't tell apart from real paths. Auto detection removed;
 *      file opens now go through the explicit `@file` mention menu only.)
 *   2. Highlight.js code blocks via markdown-it `highlight` option
 *      (no third-party plugin needed — markdown-it ships the hook).
 *   3. Markdown links styled via `var(--link)` from theme.
 *      `linkify: true` still auto-links `https://...` / `mailto:` as
 *      `<a>`s — those go through the browser default nav (no override).
 */
function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

// Forward reference: `md` is needed by the `highlight` callback below.
let md!: MarkdownIt
const mdOptions: Options = {
  html: false,        // raw HTML disabled (XSS guard)
  linkify: false,      // disable auto-linking URLs — users click links to navigate away from the SPA
  breaks: true,
  highlight(str: string, lang: string): string {
    // Mermaid is deliberately NOT highlighted: markdown-it emits a placeholder
    // that `useMermaid` upgrades to a real SVG after the DOM settles (the source
    // is kept in a hidden <pre> so Copy / the enlarged view can reuse it).
    if (lang.toLowerCase() === 'mermaid') {
      // Toolbar mirrors the familiar diagram-viewer layout: 图表 / 代码 on the
      // left, zoom + 全屏 + 下载 on the right. Zoom is button/double-click only —
      // the inline canvas never swallows the page's wheel.
      return '<div class="mermaid-block" data-mermaid-state="pending" data-mermaid-view="chart">'
        + '<div class="mermaid-bar">'
        + '<div class="mermaid-tabs">'
        + '<button class="mermaid-view is-active" type="button" data-view="chart">图表</button>'
        + '<button class="mermaid-view" type="button" data-view="code">代码</button>'
        + '</div>'
        + '<div class="mermaid-tools">'
        + '<button class="mermaid-btn mermaid-out" type="button" title="缩小 20%">缩小</button>'
        + '<button class="mermaid-btn mermaid-in" type="button" title="放大 25%">放大</button>'
        + '<button class="mermaid-btn mermaid-fit" type="button" title="适应宽度">适应</button>'
        + '<button class="mermaid-btn mermaid-download" type="button" title="下载 SVG">下载</button>'
        + '<button class="mermaid-btn mermaid-full" type="button" title="全屏">全屏</button>'
        + '</div>'
        + '</div>'
        + '<div class="mermaid-canvas"></div>'
        + `<pre class="mermaid-src" hidden>${md.utils.escapeHtml(str)}</pre>`
        + '</div>'
    }
    const copyBtn = '<button class="code-copy-btn" type="button">Copy</button>'
    // Language tag (e.g. "typescript", "java") rendered top-left of the block
    // so readers can identify the code at a glance. Only emitted when hljs
    // actually knows the language — untyped blocks stay tagless.
    const langTag = lang ? `<span class="code-lang">${escapeAttr(lang)}</span>` : ''
    if (lang && hljs.getLanguage(lang)) {
      try {
        const out = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
        return `<pre class="hljs">${langTag}${copyBtn}<code class="hljs language-${escapeAttr(lang)}">${out}</code></pre>`
      } catch {
        // fall through to escaped default
      }
    }
    return `<pre class="hljs">${langTag}${copyBtn}<code>${md.utils.escapeHtml(str)}</code></pre>`
  },
}
md = new MarkdownIt(mdOptions)

// Wrap every <table> in a <div class="table-wrapper"> so wide tables get an
// INTERNAL horizontal scrollbar instead of pushing the whole chat pane wider.
// Default markdown-it output is bare <table>...</table>; without the wrapper,
// long unbreakable tokens (paths, URLs, single English words) blow out the
// page width and a window-level scrollbar appears.
md.renderer.rules.table_open = function () {
  return '<div class="table-wrapper">\n<table>\n'
}
md.renderer.rules.table_close = function () {
  return '</table>\n</div>\n'
}

const html = computed(() => md.render(props.source ?? ''))

/**
 * Click delegate for the whole rendered tree:
 * - `.code-copy-btn` — highlight.js code block copy
 * - mermaid toolbar — 图表/代码、缩放、适应、下载、全屏
 * Markdown links (auto-linked URLs and `[label](url)`) flow through normal
 * browser navigation — no override. File open is exclusively driven by
 * `@file` mentions (see FileSearchMenu).
 */
const rootEl = ref<HTMLElement | null>(null)
const {
  findBlock: findMermaidBlock,
  openZoom: openMermaidZoom,
  zoomBlock: zoomMermaidBlock,
  fitBlock: fitMermaidBlock,
  setBlockView: setMermaidView,
  downloadBlock: downloadMermaidBlock,
  zoom: mermaidZoom,
  zoomScale: mermaidZoomScale,
  zoomPercent: mermaidZoomPercent,
  zoomStage: mermaidZoomStage,
  closeZoom: closeMermaidZoom,
  zoomIn: mermaidZoomIn,
  zoomOut: mermaidZoomOut,
  resetZoom: mermaidResetZoom,
  copyZoomSource: copyMermaidZoomSource,
} = useMermaid(rootEl, html)

async function onLinkClick(e: MouseEvent): Promise<void> {
  const target = e.target as HTMLElement | null
  if (!target) return

  const copyBtn = target.closest('button.code-copy-btn') as HTMLButtonElement | null
  if (copyBtn) {
    e.preventDefault()
    const pre = copyBtn.closest('pre')
    const code = pre?.querySelector('code')
    const text = code?.textContent ?? ''
    try {
      await navigator.clipboard.writeText(text)
      const old = copyBtn.textContent
      copyBtn.textContent = 'Copied!'
      setTimeout(() => { copyBtn.textContent = old }, 1200)
    } catch {
      copyBtn.textContent = 'Failed'
      setTimeout(() => { copyBtn.textContent = 'Copy' }, 1200)
    }
    return
  }

  const mermaidViewBtn = target.closest('button.mermaid-view[data-view]') as HTMLButtonElement | null
  if (mermaidViewBtn) {
    e.preventDefault()
    const block = findMermaidBlock(mermaidViewBtn)
    const view = mermaidViewBtn.dataset.view === 'code' ? 'code' : 'chart'
    setMermaidView(block, view)
    return
  }

  const mermaidTool = target.closest(
    'button.mermaid-in, button.mermaid-out, button.mermaid-fit, button.mermaid-download, button.mermaid-full',
  ) as HTMLButtonElement | null
  if (mermaidTool) {
    e.preventDefault()
    const block = findMermaidBlock(mermaidTool)
    if (!block) return
    if (mermaidTool.classList.contains('mermaid-in')) zoomMermaidBlock(block, 1.25)
    else if (mermaidTool.classList.contains('mermaid-out')) zoomMermaidBlock(block, 1 / 1.25)
    else if (mermaidTool.classList.contains('mermaid-fit')) fitMermaidBlock(block)
    else if (mermaidTool.classList.contains('mermaid-download')) downloadMermaidBlock(block)
    else openMermaidZoom(block)
    return
  }
}
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div ref="rootEl" class="markdown-body" v-html="html" @click="onLinkClick" />

  <!-- Enlarged diagram viewer. Teleported to <body> so the chat column's
       overflow/stacking contexts can't clip it; scoped styles still apply. -->
  <Teleport to="body">
    <div v-if="mermaidZoom" class="mermaid-zoom-mask" @click.self="closeMermaidZoom">
      <div class="mermaid-zoom-panel">
        <div class="mermaid-zoom-bar">
          <span class="mermaid-zoom-title">mermaid</span>
          <div class="mermaid-zoom-tools">
            <button type="button" title="缩小" @click="mermaidZoomOut">−</button>
            <span class="mermaid-zoom-scale">{{ mermaidZoomPercent }}</span>
            <button type="button" title="放大" @click="mermaidZoomIn">＋</button>
            <button type="button" title="恢复 100%" @click="mermaidResetZoom">1:1</button>
            <button type="button" @click="copyMermaidZoomSource">Copy</button>
            <button type="button" class="mermaid-zoom-close" title="关闭 (Esc)" @click="closeMermaidZoom">✕</button>
          </div>
        </div>
        <div class="mermaid-zoom-body">
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div
            ref="mermaidZoomStage"
            class="mermaid-zoom-stage"
            title="拖拽移动 · 滚轮缩放 · 双击复位"
            v-html="mermaidZoom?.svg ?? ''"
          />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.markdown-body {
  word-wrap: break-word;
}
/* Tailwind v4 preflight resets <p> margin to 0 and <hr> border to currentColor
   (so <hr> renders in the same color as body text — invisible against light bg).
   Restore standard markdown typography inside our scoped tree. */
.markdown-body :deep(p) {
  margin: 0 0 0.8em 0;
}
.markdown-body :deep(p:last-child) {
  margin-bottom: 0;
}
.markdown-body :deep(hr) {
  border: 0;
  border-top: 1px solid var(--hr-color);
  height: 0;
  margin: 16px 0;
}
/* Tailwind v4 preflight sets h1-h6 { font-size: inherit; font-weight: inherit; margin: 0 },
   wiping the default browser hierarchy. Restore GitHub-style scale. No
   border-bottom on h1/h2 — that visually reads as a separator and the
   <hr> rule above is the only place where --- should render a separator.
   Heading top margin is non-zero on purpose: without it, headings collapse
   to 0 against their previous sibling (e.g. <ul> + <h3> = 0 + 0 = 0), making
   the heading look glued to the preceding block. */
.markdown-body :deep(h1) {
  font-size: 1.6em;
  font-weight: 700;
  margin: 1.2em 0 0.6em;
}
.markdown-body :deep(h2) {
  font-size: 1.35em;
  font-weight: 700;
  margin: 1.2em 0 0.5em;
}
.markdown-body :deep(h3) {
  font-size: 1.15em;
  font-weight: 600;
  margin: 1em 0 0.4em;
}
.markdown-body :deep(h4) {
  font-size: 1em;
  font-weight: 600;
  margin: 1em 0 0.3em;
}
.markdown-body :deep(h5),
.markdown-body :deep(h6) {
  font-size: 1em;
  font-weight: 600;
  margin: 1em 0 0.3em;
  color: var(--text-secondary);
}
/* Tailwind preflight zeros <ul>/<ol> margin (the * { margin: 0 } universal rule).
   Restore block margin so lists sit on their own line and have visual spacing
   before a following heading. */
.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 0 0 0.8em;
}
.markdown-body :deep(.table-wrapper) {
  /* Internal horizontal scroll for wide tables. Wrapper stays inside the chat
     message column; only this container grows wider, so the page-level
     scrollbar doesn't appear. */
  overflow-x: auto;
  margin: 8px 0;
}
.markdown-body :deep(pre) {
  position: relative;
  border-radius: 6px;
  padding: 12px;
  padding-top: 32px; /* leave room for copy button */
  overflow-x: auto;
  background: var(--hover-bg);
}
.markdown-body :deep(pre .code-copy-btn) {
  position: absolute;
  top: 4px;
  right: 6px;
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s;
}
.markdown-body :deep(pre:hover .code-copy-btn) {
  opacity: 1;
}
.markdown-body :deep(pre .code-copy-btn:hover) {
  background: var(--user-bubble-bg);
  color: var(--user-bubble-text);
  border-color: var(--user-bubble-bg);
}
.markdown-body :deep(.code-lang) {
  position: absolute;
  top: 6px;
  left: 10px;
  font-size: 11px;
  color: var(--text-secondary);
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  opacity: 0.75;
  pointer-events: none;
  user-select: none;
  /* Match the copy button's vertical position so they share the same row. */
  line-height: 20px;
}
.markdown-body :deep(code) {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 13px;
}
.markdown-body :deep(:not(pre) > code) {
  background: var(--hover-bg-strong);
  padding: 2px 5px;
  border-radius: 3px;
}
.markdown-body :deep(a) {
  color: var(--link);
}
.markdown-body :deep(blockquote) {
  border-left: 3px solid var(--border);
  margin: 8px 0;
  padding-left: 12px;
  color: var(--text-secondary);
}

/* ---------------- Mermaid diagrams ---------------- */
.markdown-body :deep(.mermaid-block) {
  position: relative;
  margin: 10px 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--hover-bg);
  overflow: hidden;
}
/* Toolbar strip: 图表/代码 tabs on the left, zoom/fullscreen/download on the right. */
.markdown-body :deep(.mermaid-bar) {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--hover-bg);
}
.markdown-body :deep(.mermaid-tabs) {
  display: flex;
  gap: 2px;
}
.markdown-body :deep(.mermaid-view) {
  font-size: 11.5px;
  padding: 3px 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.markdown-body :deep(.mermaid-view.is-active) {
  background: var(--bg-primary);
  color: var(--text-primary);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.markdown-body :deep(.mermaid-tools) {
  display: flex;
  align-items: center;
  gap: 4px;
}
.markdown-body :deep(.mermaid-btn) {
  min-width: 24px;
  height: 22px;
  padding: 0 6px;
  font-size: 11.5px;
  line-height: 20px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.markdown-body :deep(.mermaid-btn:hover) {
  background: var(--bg-primary);
  border-color: var(--border);
  color: var(--text-primary);
}
.markdown-body :deep(.mermaid-canvas) {
  /* Infinite canvas: the diagram keeps its intrinsic size and is moved by a
     transform, so nothing is ever shrunk below its designed size (that is what
     used to render 14px labels at 5px and eat 1px connectors). No scrollbars and
     no wheel handling — zoom comes from the toolbar / double-click, drag pans.
     Height is set inline by the renderer from the fitted size. */
  position: relative;
  overflow: hidden;
  cursor: grab;
  touch-action: pan-y;
  margin: 6px;
  border-radius: 4px;
}
.markdown-body :deep(.mermaid-canvas[hidden]) {
  display: none;
}
.markdown-body :deep(.mermaid-canvas[data-dragging='true']) {
  cursor: grabbing;
}
.markdown-body :deep(.mermaid-canvas svg) {
  max-width: none;
  width: auto;
  height: auto;
  user-select: none;
  -webkit-user-drag: none;
}
/* mermaid 12's `neo` look stamps a light drop-shadow on every node; on a dark
   page that reads as a white glow. The SVG carries its own <style>, so this
   override (not just inline-style cleanup) is what guarantees flat shapes. */
.markdown-body :deep(.mermaid-canvas svg *),
.markdown-body :deep(.mermaid-zoom-stage svg *) {
  filter: none !important;
}
/* Without this a 1px connector becomes sub-pixel when the SVG is scaled down and
   simply disappears — the classic "lines are missing" mermaid symptom. */
.markdown-body :deep(.mermaid-canvas svg path),
.markdown-body :deep(.mermaid-canvas svg line),
.markdown-body :deep(.mermaid-canvas svg polyline),
.markdown-body :deep(.mermaid-canvas svg rect),
.markdown-body :deep(.mermaid-canvas svg polygon),
.markdown-body :deep(.mermaid-canvas svg circle),
.markdown-body :deep(.mermaid-canvas svg ellipse),
.markdown-body :deep(.mermaid-zoom-stage svg path),
.markdown-body :deep(.mermaid-zoom-stage svg line),
.markdown-body :deep(.mermaid-zoom-stage svg polyline) {
  vector-effect: non-scaling-stroke;
}
/* Streaming: show the source (readable, copyable) instead of an empty box. */
.markdown-body :deep(.mermaid-block[data-mermaid-state='waiting'] .mermaid-canvas) {
  display: none;
}
.markdown-body :deep(.mermaid-block[data-mermaid-state='waiting'] .mermaid-src) {
  display: block;
  margin: 0;
  padding: 8px 10px;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.75;
}
/* Keep a stable footprint while the diagram is still pending/rendering so the
   message doesn't jump when the SVG lands (streaming tail). */
.markdown-body :deep(.mermaid-block[data-mermaid-state='pending'] .mermaid-canvas),
.markdown-body :deep(.mermaid-block[data-mermaid-state='rendering'] .mermaid-canvas) {
  min-height: 40px;
}
/* Code view: the same source the renderer consumed, monospace and copyable. */
.markdown-body :deep(.mermaid-block[data-mermaid-view='code'] .mermaid-src) {
  display: block;
  margin: 0;
  padding: 10px 12px;
  background: transparent;
  color: var(--text-secondary);
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.markdown-body :deep(.mermaid-error) {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  color: #d14343;
  white-space: pre-wrap;
  text-align: left;
  cursor: default;
}

/* Enlarged viewer (teleported to body, so not nested in .markdown-body) */
.mermaid-zoom-mask {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
}
.mermaid-zoom-panel {
  display: flex;
  flex-direction: column;
  width: 92vw;
  height: 90vh;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-primary);
  box-shadow: var(--shadow-popup, 0 12px 40px rgba(0, 0, 0, 0.35));
  overflow: hidden;
}
.mermaid-zoom-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--hover-bg);
}
.mermaid-zoom-title {
  font-size: 12px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  color: var(--text-secondary);
}
.mermaid-zoom-tools {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mermaid-zoom-tools button {
  font-size: 12px;
  min-width: 28px;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.mermaid-zoom-tools button:hover {
  background: var(--link);
  border-color: var(--link);
  color: #fff;
}
.mermaid-zoom-scale {
  font-size: 12px;
  min-width: 40px;
  text-align: center;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.mermaid-zoom-body {
  flex: 1;
  min-height: 0;
  padding: 12px;
  display: flex;
}
.mermaid-zoom-stage {
  /* Infinite canvas: fills the panel, pans by drag, zooms by wheel. No
     scrollbars and no inline sizing — the SVG keeps its intrinsic size and only
     a transform moves it. */
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
  border-radius: 6px;
  background: var(--hover-bg);
}
.mermaid-zoom-stage[data-dragging='true'] {
  cursor: grabbing;
}
.mermaid-zoom-stage :deep(svg) {
  /* !important is required: mermaid stamps `style="max-width: <natural>px"`
     inline on the <svg>, which otherwise wins over any stylesheet rule. */
  max-width: none !important;
  user-select: none;
  -webkit-user-drag: none;
}
</style>