<script setup lang="ts">
import { computed } from 'vue'
import MarkdownIt, { type Options } from 'markdown-it'
import hljs from 'highlight.js/lib/common'

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
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="markdown-body" v-html="html" @click="onLinkClick" />
</template>

<script lang="ts">
/**
 * Click delegate: catch code-block Copy button (`<button class="code-copy-btn">`)
 * clicks. Markdown links (auto-linked URLs and `[label](url)`) flow through
 * normal browser navigation — no override. File open is now exclusively driven
 * by `@file` mentions (see FileSearchMenu).
 */
export default {
  methods: {
    async onLinkClick(e: MouseEvent) {
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
    },
  },
}
</script>

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
  margin: 8px 0;
}
.markdown-body :deep(pre) {
  position: relative;
  border-radius: 6px;
  padding: 12px;
  padding-top: 32px; /* leave room for copy button */
  overflow-x: auto;
  background: var(--surface-hover);
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
  background: var(--surface-hover);
  padding: 2px 5px;
  border-radius: 3px;
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
</style>