<script setup lang="ts">
import { computed, ref } from 'vue'
import MarkdownIt, { type Options } from 'markdown-it'
import hljs from 'highlight.js/lib/common'
import { useMermaid } from '../../composables/useMermaid'

const props = defineProps<{
  source: string
  /** Extra class names to add to rendered code blocks (used by code-block copy button). */
  codeBlockClassName?: string
  /**
   * True while the message is still being streamed. Mermaid diagrams are NOT
   * rendered in that state: a half-written fence would parse-fail, flash an
   * error, and burn a full parse on every pause. The block shows its source
   * instead and renders once the run settles.
   */
  streaming?: boolean
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
 *   3. Markdown links styled via `var(--accent)` from theme.
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
      return '<div class="mermaid-block" data-mermaid-state="pending">'
        + '<span class="mermaid-label">mermaid</span>'
        + '<button class="mermaid-copy" type="button">Copy</button>'
        + '<button class="mermaid-zoom" type="button">放大</button>'
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
 * - `.mermaid-copy` / `.mermaid-zoom` — mermaid block toolbar
 * - the rendered diagram itself — opens the enlarged view
 * Markdown links (auto-linked URLs and `[label](url)`) flow through normal
 * browser navigation — no override. File open is exclusively driven by
 * `@file` mentions (see FileSearchMenu).
 */
const rootEl = ref<HTMLElement | null>(null)
const {
  copySource: copyMermaidSource,
  findBlock: findMermaidBlock,
  openZoom: openMermaidZoom,
  zoom: mermaidZoom,
  zoomStage: mermaidZoomStage,
  zoomScale: mermaidZoomScale,
  zoomPercent: mermaidZoomPercent,
  closeZoom: closeMermaidZoom,
  zoomIn: mermaidZoomIn,
  zoomOut: mermaidZoomOut,
  resetZoom: mermaidResetZoom,
  copyZoomSource: copyMermaidZoomSource,
} = useMermaid(rootEl, html, computed(() => props.streaming === true))

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

  const mermaidCopyBtn = target.closest('button.mermaid-copy') as HTMLButtonElement | null
  if (mermaidCopyBtn) {
    e.preventDefault()
    const block = findMermaidBlock(mermaidCopyBtn)
    if (block) await copyMermaidSource(mermaidCopyBtn, block)
    return
  }

  const mermaidZoomBtn = target.closest('button.mermaid-zoom') as HTMLButtonElement | null
  if (mermaidZoomBtn) {
    e.preventDefault()
    const block = findMermaidBlock(mermaidZoomBtn)
    if (block) openMermaidZoom(block)
    return
  }

  // Clicking the diagram itself opens the enlarged view.
  if (target.closest('.mermaid-canvas svg')) {
    const block = findMermaidBlock(target)
    if (block) openMermaidZoom(block)
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
  border-top: 1px solid var(--border);
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
  margin: 10px 0;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  line-height: 1.55;
}
.markdown-body :deep(thead th) {
  background: var(--surface-hover);
  color: var(--text);
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
}
.markdown-body :deep(th),
.markdown-body :deep(td) {
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  border-right: 1px solid var(--border);
  vertical-align: top;
}
.markdown-body :deep(th:last-child),
.markdown-body :deep(td:last-child) {
  border-right: 0;
}
.markdown-body :deep(tbody tr:last-child td) {
  border-bottom: 0;
}
.markdown-body :deep(tbody tr:nth-child(even)) {
  /* Very light zebra so long tables stay scannable without looking striped. */
  background: color-mix(in srgb, var(--surface-hover) 45%, transparent);
}
.markdown-body :deep(pre) {
  position: relative;
  border-radius: 8px;
  padding: 12px;
  padding-top: 32px; /* leave room for copy button */
  overflow-x: auto;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  line-height: 1.6;
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
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}
.markdown-body :deep(.code-lang) {
  position: absolute;
  top: 6px;
  left: 10px;
  font-size: 11px;
  color: var(--text-secondary);
  font-family: var(--font-mono);
  opacity: 0.75;
  pointer-events: none;
  user-select: none;
  /* Match the copy button's vertical position so they share the same row. */
  line-height: 20px;
}
.markdown-body :deep(code) {
  font-family: var(--font-mono);
  font-size: 13px;
}
.markdown-body :deep(:not(pre) > code) {
  background: var(--code-inline-bg);
  border: 1px solid var(--code-border);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 0.92em;
}
.markdown-body :deep(a) {
  color: var(--accent);
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
  padding: 10px;
  padding-top: 30px; /* room for the label + toolbar */
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-subtle);
}
.markdown-body :deep(.mermaid-canvas) {
  /* Infinite canvas: the diagram keeps its intrinsic size and is moved by a
     transform, so nothing is ever shrunk below its designed size (that is what
     used to render 14px labels at 5px and eat 1px connectors). No scrollbars —
     drag to pan, wheel to zoom, double-click to re-fit. Height is set inline by
     the renderer from the fitted size. */
  position: relative;
  overflow: hidden;
  cursor: grab;
  touch-action: pan-y;
  border-radius: 4px;
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
  background: var(--mermaid-src-bg, transparent);
  color: var(--text-2);
  font-family: var(--font-mono);
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
.markdown-body :deep(.mermaid-label) {
  position: absolute;
  top: 6px;
  left: 10px;
  font-size: 11px;
  line-height: 20px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  opacity: 0.75;
  pointer-events: none;
  user-select: none;
}
.markdown-body :deep(.mermaid-copy),
.markdown-body :deep(.mermaid-zoom) {
  position: absolute;
  top: 4px;
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
.markdown-body :deep(.mermaid-copy) {
  right: 54px;
}
.markdown-body :deep(.mermaid-zoom) {
  right: 6px;
}
.markdown-body :deep(.mermaid-block:hover .mermaid-copy),
.markdown-body :deep(.mermaid-block:hover .mermaid-zoom) {
  opacity: 1;
}
.markdown-body :deep(.mermaid-copy:hover),
.markdown-body :deep(.mermaid-zoom:hover) {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.markdown-body :deep(.mermaid-error) {
  font-family: var(--font-mono);
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
  background: var(--surface);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.mermaid-zoom-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-hover);
}
.mermaid-zoom-title {
  font-size: 12px;
  font-family: var(--font-mono);
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
  background: var(--accent);
  border-color: var(--accent);
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
  background: var(--surface-subtle);
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