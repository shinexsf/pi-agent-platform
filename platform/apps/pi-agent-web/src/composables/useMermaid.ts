/**
 * Mermaid diagram rendering for assistant markdown.
 *
 * Why this is DOM-driven instead of a Vue component per diagram:
 * markdown-it returns a sanitized HTML string that we inject with `v-html` — Vue
 * components cannot be embedded in that string. So the renderer emits a
 * placeholder (`.mermaid-block[data-mermaid-state="pending"]`) and this composable
 * upgrades every placeholder to a real SVG after the DOM settles.
 *
 * Design constraints:
 * - **Lazy chunk**: `mermaid` is ~1MB of parser + diagram engines, so it is
 *   `import()`ed on the first diagram and never on plain-text chats.
 * - **Debounced**: assistant content streams token by token via `v-html`, which
 *   recreates the placeholders on every delta. Rendering on each delta would
 *   thrash; we wait for the source to be quiet for `RENDER_DEBOUNCE_MS` instead.
 * - **SVG cache**: keyed by theme + source, so a re-render (streaming tail,
 *   re-mount, same diagram twice) is an `innerHTML` assignment, not a parse.
 * - **Failure containment**: a bad diagram must not blank the message — the
 *   block flips to `data-mermaid-state="error"` and shows the message, and the
 *   original source stays reachable through the Copy button.
 */

import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue'

const RENDER_DEBOUNCE_MS = 300
const MAX_CACHE_ENTRIES = 80

/** Rendered `svg` markup keyed by `<theme>::<source>`. Module-scoped on purpose:
 *  every assistant message shares one cache across the whole session. */
const svgCache = new Map<string, string>()
let mermaidLoader: Promise<MermaidLike> | null = null
let diagramSeq = 0

interface MermaidLike {
  initialize: (config: Record<string, unknown>) => void
  parse: (text: string, opts?: { suppressErrors?: boolean }) => Promise<unknown>
  render: (
    id: string,
    text: string,
    container?: HTMLElement,
  ) => Promise<{ svg: string; bindFunctions?: (el: Element) => void }>
}

export type MermaidTheme = 'dark' | 'default'

/**
 * Resolve the active palette from the two conventions in this repo:
 * - pi-agent-web: `<html data-theme="dark|light">`
 * - pi-agent-ide: `<html data-mode="dark">` (JCEF-injected), no attribute in a
 *   plain browser where `prefers-color-scheme` is the fallback.
 */
export function resolveMermaidTheme(): MermaidTheme {
  const attr = document.documentElement.getAttribute('data-theme')
    ?? document.documentElement.getAttribute('data-mode')
  if (attr) return attr === 'dark' ? 'dark' : 'default'
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'default'
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function getMermaid(): Promise<MermaidLike> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then((mod) => {
      const mermaid = (mod as unknown as { default: MermaidLike }).default ?? (mod as unknown as MermaidLike)
      mermaid.initialize({
        startOnLoad: false,
        // Mermaid's own label sanitizer; keeps click handlers/HTML in labels inert.
        securityLevel: 'strict',
        theme: resolveMermaidTheme(),
        fontFamily: 'inherit',
      })
      return mermaid
    })
  }
  return mermaidLoader
}

export interface MermaidZoomState {
  svg: string
  source: string
  /** Intrinsic diagram width in CSS px (mermaid writes it as an inline
   *  `max-width` on the `<svg>`); the zoom controls multiply from here. */
  naturalWidth: number
}

export function useMermaid(
  root: Ref<HTMLElement | null>,
  source: Ref<string> | ComputedRef<string>,
) {
  const zoom = ref<MermaidZoomState | null>(null)
  const zoomScale = ref(1)
  // Multiplicative steps: the opened diagram is already fitted to the viewport,
  // so a fixed +/- px step would be tiny on big graphs and huge on small ones.
  const ZOOM_STEP = 1.25
  const ZOOM_MIN = 0.25
  const ZOOM_MAX = 6

  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  /** Remove the transient `#d<id>`/`i<id>` nodes mermaid leaves behind on failure. */
  function cleanupArtifacts(): void {
    for (const el of document.querySelectorAll('body > div[id^="dmermaid-"], body > div[id^="d3-"]')) {
      el.remove()
    }
  }

  async function renderPending(): Promise<void> {
    const host = root.value
    if (!host || disposed) return
    const pending = Array.from(
      host.querySelectorAll<HTMLElement>('.mermaid-block[data-mermaid-state="pending"]'),
    )
    if (pending.length === 0) return

    const theme = resolveMermaidTheme()
    let mermaid: MermaidLike
    let retryPending = false
    try {
      mermaid = await getMermaid()
    } catch (err) {
      for (const block of pending) {
        block.dataset.mermaidState = 'error'
        const canvas = block.querySelector<HTMLElement>('.mermaid-canvas')
        if (canvas) {
          canvas.innerHTML = `<div class="mermaid-error">Mermaid 加载失败：${escapeHtml(String((err as Error)?.message ?? err))}</div>`
        }
      }
      return
    }
    // Theme can flip between batches (user toggles light/dark) — re-init so new
    // diagrams match; cached entries are keyed by theme so old ones stay valid.
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'inherit' })

    for (const block of pending) {
      if (disposed) return
      block.dataset.mermaidState = 'rendering'
      const canvas = block.querySelector<HTMLElement>('.mermaid-canvas')
      const sourceEl = block.querySelector<HTMLElement>('.mermaid-src')
      const text = sourceEl?.textContent ?? ''
      if (!canvas) continue
      if (!text.trim()) {
        block.dataset.mermaidState = 'empty'
        canvas.innerHTML = '<div class="mermaid-error">空 mermaid 代码块</div>'
        continue
      }

      const cacheKey = `${theme}::${text}`
      const cached = svgCache.get(cacheKey)
      if (cached) {
        canvas.innerHTML = cached
        block.dataset.mermaidState = 'ready'
        continue
      }

      try {
        const ok = await mermaid.parse(text, { suppressErrors: true })
        if (ok === false) throw new Error('语法解析失败')
        const id = `pi-mermaid-${++diagramSeq}`
        const { svg, bindFunctions } = await mermaid.render(id, text)
        if (svgCache.size >= MAX_CACHE_ENTRIES) {
          const oldest = svgCache.keys().next().value
          if (oldest !== undefined) svgCache.delete(oldest)
        }
        svgCache.set(cacheKey, svg)
        canvas.innerHTML = svg
        bindFunctions?.(canvas)
        block.dataset.mermaidState = 'ready'
      } catch (err) {
        cleanupArtifacts()
        // While the assistant is still streaming, a fence can be half-written
        // (`flowchart LR` + a dangling arrow) and fail to parse. Give the same
        // text one more debounce window before surfacing an error, so a partial
        // block doesn't flash "渲染失败" for a fraction of a second.
        if (block.dataset.mermaidFailedSrc !== text) {
          block.dataset.mermaidFailedSrc = text
          block.dataset.mermaidState = 'pending'
          retryPending = true
          continue
        }
        block.dataset.mermaidState = 'error'
        canvas.innerHTML = `<div class="mermaid-error">Mermaid 渲染失败：${escapeHtml(
          String((err as Error)?.message ?? err),
        )}</div>`
      }
    }
    if (retryPending) {
      retryPending = false
      schedule()
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void renderPending()
    }, RENDER_DEBOUNCE_MS)
  }

  watch(
    source,
    () => {
      // `source` drives the `v-html` binding; the placeholders only exist after
      // the next DOM flush, so wait a microtask frame before scanning.
      void Promise.resolve().then(schedule)
    },
    { immediate: true },
  )

  function findBlock(el: HTMLElement | null): HTMLElement | null {
    return el?.closest('.mermaid-block') ?? null
  }

  function blockSource(block: HTMLElement): string {
    return block.querySelector<HTMLElement>('.mermaid-src')?.textContent ?? ''
  }

  async function copySource(button: HTMLButtonElement | null, block: HTMLElement): Promise<void> {
    const text = blockSource(block)
    if (!button) return
    const original = button.textContent ?? 'Copy'
    try {
      await navigator.clipboard.writeText(text)
      button.textContent = 'Copied!'
    } catch {
      button.textContent = 'Failed'
    }
    setTimeout(() => {
      button.textContent = original
    }, 1200)
  }

  function openZoom(block: HTMLElement): void {
    const canvas = block.querySelector<HTMLElement>('.mermaid-canvas')
    if (!canvas || block.dataset.mermaidState !== 'ready') return
    const svgEl = canvas.querySelector('svg')
    // Mermaid stamps `style="max-width: <natural>px"` on the root <svg>; that is
    // the size the diagram wants before the chat column squeezes it.
    const styled = svgEl ? Number.parseFloat(svgEl.style.maxWidth) : Number.NaN
    const measured = svgEl?.getBoundingClientRect().width ?? 0
    const naturalWidth = Number.isFinite(styled) && styled > 0 ? styled : measured || 800

    zoom.value = { svg: canvas.innerHTML, source: blockSource(block), naturalWidth }
    // Open "fitted": fill most of the panel instead of matching the cramped
    // chat column width, but never shrink below 100%.
    const panelContent = Math.max(320, window.innerWidth * 0.92 - 32)
    zoomScale.value = +Math.min(ZOOM_MAX, Math.max(1, panelContent / naturalWidth)).toFixed(2)
  }

  function closeZoom(): void {
    zoom.value = null
  }

  function zoomIn(): void {
    zoomScale.value = Math.min(ZOOM_MAX, +(zoomScale.value * ZOOM_STEP).toFixed(2))
  }

  function zoomOut(): void {
    zoomScale.value = Math.max(ZOOM_MIN, +(zoomScale.value / ZOOM_STEP).toFixed(2))
  }

  function resetZoom(): void {
    zoomScale.value = 1
  }

  async function copyZoomSource(): Promise<void> {
    if (!zoom.value) return
    try {
      await navigator.clipboard.writeText(zoom.value.source)
    } catch {
      /* clipboard unavailable (non-secure context) — nothing sensible to do */
    }
  }

  function onEscape(e: KeyboardEvent): void {
    if (e.key === 'Escape' && zoom.value) {
      e.stopPropagation()
      closeZoom()
    }
  }

  watch(zoom, (state) => {
    if (state) window.addEventListener('keydown', onEscape, true)
    else window.removeEventListener('keydown', onEscape, true)
  })

  // Palette switch: mermaid bakes colours into the SVG, so a rendered diagram
  // keeps the old theme until it is built again. Reset every rendered block to
  // `pending` and re-render — the cache is keyed by theme, so only the first
  // diagram of each palette actually pays for a parse.
  let currentTheme = resolveMermaidTheme()
  function onThemeChange(): void {
    const next = resolveMermaidTheme()
    if (next === currentTheme) return
    currentTheme = next
    zoom.value = null
    const host = root.value
    if (!host) return
    for (const block of host.querySelectorAll<HTMLElement>('.mermaid-block[data-mermaid-state]')) {
      block.dataset.mermaidState = 'pending'
      const canvas = block.querySelector<HTMLElement>('.mermaid-canvas')
      if (canvas) canvas.innerHTML = ''
    }
    schedule()
  }
  // pi-agent-web toggles `data-theme`; pi-agent-ide's JCEF sets `data-mode`.
  const themeObserver = new MutationObserver(onThemeChange)
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-mode'],
  })
  const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)')
  darkQuery?.addEventListener?.('change', onThemeChange)

  onBeforeUnmount(() => {
    disposed = true
    if (timer) clearTimeout(timer)
    window.removeEventListener('keydown', onEscape, true)
    themeObserver.disconnect()
    darkQuery?.removeEventListener?.('change', onThemeChange)
  })

  const zoomPercent = computed(() => `${Math.round(zoomScale.value * 100)}%`)
  /** Rendered width of the diagram: resizing the box (not a CSS transform)
   *  makes the enlarged diagram part of the layout, so overflow scrolling
   *  reaches every edge — a transform would only paint outside the box. */
  const zoomWidth = computed(() => {
    const natural = zoom.value?.naturalWidth ?? 800
    return `${Math.round(natural * zoomScale.value)}px`
  })

  return {
    // rendering
    schedule,
    renderPending,
    // delegated click helpers
    findBlock,
    blockSource,
    copySource,
    openZoom,
    // zoom modal
    zoom,
    zoomScale,
    zoomPercent,
    zoomWidth,
    closeZoom,
    zoomIn,
    zoomOut,
    resetZoom,
    copyZoomSource,
  }
}
