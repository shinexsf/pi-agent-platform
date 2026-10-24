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

import { computed, nextTick, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue'

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

/**
 * Mermaid measures label boxes on a `<canvas>`, where the CSS-wide `inherit`
 * keyword is meaningless — passing it makes mermaid mis-measure its nodes.
 * Resolve the page's concrete stack once instead.
 */
function resolveDiagramFont(): string {
  const stack = getComputedStyle(document.body).fontFamily
  return stack && stack.trim() ? `${stack.trim()}, sans-serif` : 'system-ui, sans-serif'
}

/**
 * Mermaid's built-in `default`/`dark` themes pick their own palettes (pale
 * yellow nodes, #ccc labels), which reads as a foreign component inside our
 * message column — and on a light page the dark theme's light labels are nearly
 * invisible. So we drive mermaid from `base` + our own design tokens: whatever
 * the app's theme is, the diagram uses the same surfaces, borders and text.
 */
function diagramThemeVariables(theme: MermaidTheme): Record<string, string> {
  const css = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string => {
    const value = css.getPropertyValue(name).trim()
    return value || fallback
  }
  const surface = read('--surface', theme === 'dark' ? '#141b27' : '#ffffff')
  // Node fill uses the raised surface: on the diagram card (which already sits on
  // `--surface-subtle`) plain `--surface` is nearly identical in dark mode and the
  // boxes disappear into the background.
  const surfaceRaised = read('--surface-raised', surface)
  const surfaceHover = read('--surface-hover', theme === 'dark' ? '#1c2432' : '#f1f4f8')
  const surfaceSubtle = read('--surface-subtle', theme === 'dark' ? '#10161f' : '#f7f9fc')
  const text = read('--text', theme === 'dark' ? '#edf2fb' : '#172033')
  const text2 = read('--text-2', theme === 'dark' ? '#b3bfd1' : '#4a5670')
  const border = read('--border', theme === 'dark' ? '#293344' : '#dfe4ec')
  const accent = read('--accent', '#315fda')
  return {
    darkMode: String(theme === 'dark'),
    background: surface,
    fontFamily: resolveDiagramFont(),
    fontSize: '14px',
    mainBkg: surfaceRaised,
    primaryColor: surfaceRaised,
    primaryTextColor: text,
    primaryBorderColor: border,
    secondaryColor: surfaceHover,
    secondaryTextColor: text,
    secondaryBorderColor: border,
    tertiaryColor: surfaceSubtle,
    tertiaryTextColor: text,
    tertiaryBorderColor: border,
    nodeBorder: border,
    nodeTextColor: text,
    textColor: text,
    titleColor: text,
    lineColor: text2,
    edgeLabelBackground: surface,
    clusterBkg: surfaceSubtle,
    clusterBorder: border,
    labelBackground: surface,
    // Sequence / class / state diagrams share these slot names.
    actorBkg: surface,
    actorBorder: border,
    actorTextColor: text,
    signalColor: text2,
    signalTextColor: text2,
    noteBkg: surfaceHover,
    noteBorder: border,
    noteTextColor: text,
    labelBoxBkg: surface,
    labelBoxBorder: border,
    labelTextColor: text,
    loopTextColor: text,
    activationBkg: surfaceHover,
    activationBorderColor: border,
    sequenceNumberColor: theme === 'dark' ? '#0d1119' : '#ffffff',
    pie1: accent,
    pie2: surfaceHover,
    pie3: surfaceSubtle,
    pieTextColor: text,
    pieTitleTextColor: text,
    git0: accent,
    git1: surfaceHover,
    gitBranchLabel0: text,
    gitBranchLabel1: text,
  }
}

function mermaidConfig(theme: MermaidTheme): Record<string, unknown> {
  const vars = diagramThemeVariables(theme)
  return {
    startOnLoad: false,
    // Mermaid's own label sanitizer; keeps click handlers/HTML in labels inert.
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: resolveDiagramFont(),
    themeVariables: vars,
    // Labels as real `<text>`/`<tspan>` instead of `<foreignObject><div>`.
    // foreignObject labels silently fail to paint in embedded webviews (QQ /
    // WeChat in-app browsers, older Chromium) — the diagram then shows boxes and
    // arrows with no text at all. Plain SVG text works everywhere.
    htmlLabels: false,
    flowchart: { htmlLabels: false, useMaxWidth: false },
    sequence: { useMaxWidth: false },
    mindmap: { useMaxWidth: false },
    journey: { useMaxWidth: false },
    // `base` is supposed to honour `mainBkg`/`primaryColor`, but several of its
    // node styles come from built-in CSS with their own hard-coded fills
    // (#e1f5fe and friends) — on a dark page that reads as a pasted-in widget.
    // These overrides pin every container shape to the app's own tokens.
    themeCSS: `
      .node rect, .node polygon, .node circle, .node ellipse, .node path,
      .cluster rect, .actor, .note, .labelBox, .classGroup rect,
      .statediagram-state rect {
        fill: ${vars.mainBkg} !important;
        stroke: ${vars.nodeBorder} !important;
      }
      .label, .nodeLabel, text {
        fill: ${vars.textColor} !important;
        color: ${vars.textColor} !important;
      }
      .edgePath path, .flowchart-link, path.relation, .messageLine0, .messageLine1 {
        stroke: ${vars.lineColor} !important;
      }
    `,
  }
}

async function getMermaid(): Promise<MermaidLike> {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then((mod) => {
      const mermaid = (mod as unknown as { default: MermaidLike }).default ?? (mod as unknown as MermaidLike)
      mermaid.initialize(mermaidConfig(resolveMermaidTheme()))
      return mermaid
    })
  }
  return mermaidLoader
}

export interface MermaidZoomState {  svg: string
  source: string
  /** Intrinsic diagram size in CSS px, taken from the SVG viewBox; the zoom
   *  controls multiply from here and the stage gets explicit w/h so the copy
   *  inside it scales exactly (see `openZoom`). */
  naturalWidth: number
  naturalHeight: number
}

/** Live pan/zoom controllers, keyed by their viewport element. */
const panZoomHandles = new WeakMap<HTMLElement, PanZoomHandle>()

const PAN_MIN_SCALE = 0.15
const PAN_MAX_SCALE = 6

export interface PanZoomHandle {
  fit: () => void
  setScale: (scale: number) => void
  zoomBy: (factor: number) => void
  destroy: () => void
}

/**
 * Infinite-canvas interaction for a diagram: no scrollbars, drag to pan, wheel
 * to zoom (anchored at the cursor), double-click to re-fit.
 *
 * The content keeps its intrinsic size and is only moved/scaled by a transform.
 * That matters because shrinking an SVG through `max-width` also shrinks its
 * text and its hairlines — a 2173px diagram in a 780px column rendered 14px
 * labels at 5px and made edges disappear. Here the geometry is untouched; the
 * reader zooms in instead.
 */
export function mountPanZoom(
  viewport: HTMLElement,
  content: HTMLElement | SVGElement,
  naturalWidth: number,
  naturalHeight: number,
  opts: { maxFitScale?: number; wheelAlways?: boolean; onScale?: (scale: number) => void } = {},
): PanZoomHandle {
  const natW = naturalWidth > 0 ? naturalWidth : 800
  const natH = naturalHeight > 0 ? naturalHeight : 400
  let scale = 1
  let x = 0
  let y = 0

  content.style.position = 'absolute'
  content.style.top = '0'
  content.style.left = '0'
  content.style.transformOrigin = '0 0'
  content.style.display = 'block'

  const apply = (): void => {
    content.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`
    opts.onScale?.(scale)
  }
  const box = (): { w: number; h: number } => ({
    w: viewport.clientWidth || 1,
    h: viewport.clientHeight || 1,
  })
  const center = (): void => {
    const { w, h } = box()
    x = (w - natW * scale) / 2
    y = (h - natH * scale) / 2
    apply()
  }
  const fit = (): void => {
    const { w, h } = box()
    const target = Math.min(opts.maxFitScale ?? 1, w / natW, h / natH)
    scale = Math.max(PAN_MIN_SCALE, Math.min(PAN_MAX_SCALE, target))
    center()
  }
  const zoomAt = (factor: number, px: number, py: number): void => {
    const next = Math.max(PAN_MIN_SCALE, Math.min(PAN_MAX_SCALE, scale * factor))
    if (next === scale) return
    // Keep the point under the cursor anchored while the scale changes.
    x = px - ((px - x) * next) / scale
    y = py - ((py - y) * next) / scale
    scale = next
    apply()
  }

  let dragging = false
  let active = false
  let lastX = 0
  let lastY = 0

  const onPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    dragging = true
    interacted = true
    active = true
    viewport.dataset.active = 'true'
    lastX = e.clientX
    lastY = e.clientY
    viewport.dataset.dragging = 'true'
    viewport.setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }
  const onPointerMove = (e: PointerEvent): void => {
    if (!dragging) return
    x += e.clientX - lastX
    y += e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    apply()
  }
  const onPointerUp = (e: PointerEvent): void => {
    if (!dragging) return
    dragging = false
    delete viewport.dataset.dragging
    viewport.releasePointerCapture?.(e.pointerId)
  }
  // Wheel zooms only when the reader clearly means it: Ctrl/Command (the
  // standard zoom gesture) or after clicking into the canvas. A plain wheel
  // still scrolls the conversation — hijacking it unasked traps the page inside
  // a big diagram, which is worse than the extra keystroke.
  const onWheel = (e: WheelEvent): void => {
    if (!(opts.wheelAlways || e.ctrlKey || e.metaKey || active)) return
    e.preventDefault()
    interacted = true
    const rect = viewport.getBoundingClientRect()
    const step = e.deltaMode === 1 ? 0.02 : 0.0015
    zoomAt(Math.exp(-e.deltaY * step), e.clientX - rect.left, e.clientY - rect.top)
  }
  const onDoubleClick = (e: MouseEvent): void => {
    e.preventDefault()
    fit()
  }
  viewport.addEventListener('pointerdown', onPointerDown)
  viewport.addEventListener('pointermove', onPointerMove)
  viewport.addEventListener('pointerup', onPointerUp)
  viewport.addEventListener('pointercancel', onPointerUp)
  viewport.addEventListener('wheel', onWheel, { passive: false })
  viewport.addEventListener('dblclick', onDoubleClick)

  // Clicking anywhere else ends the wheel-zooms-here mode.
  const onDocumentPointerDown = (e: PointerEvent): void => {
    if (viewport.contains(e.target as Node)) return
    active = false
    delete viewport.dataset.active
  }
  document.addEventListener('pointerdown', onDocumentPointerDown, true)

  // Keep the diagram centred when the column resizes. Until the reader touches
  // it, also re-fit: the mount-time measurement can run before layout, when the
  // viewport still reports 0 width.
  let interacted = false
  const observer = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
        if (interacted) center()
        else fit()
      })
    : null
  observer?.observe(viewport)

  fit()

  return {
    fit,
    setScale: (next: number) => {
      const { w, h } = box()
      zoomAt(next / scale, w / 2, h / 2)
    },
    zoomBy: (factor: number) => {
      const { w, h } = box()
      zoomAt(factor, w / 2, h / 2)
    },
    destroy: () => {
      observer?.disconnect()
      document.removeEventListener('pointerdown', onDocumentPointerDown, true)
      viewport.removeEventListener('pointerdown', onPointerDown)
      viewport.removeEventListener('pointermove', onPointerMove)
      viewport.removeEventListener('pointerup', onPointerUp)
      viewport.removeEventListener('pointercancel', onPointerUp)
      viewport.removeEventListener('wheel', onWheel)
      viewport.removeEventListener('dblclick', onDoubleClick)
    },
  }
}

export function useMermaid(
  root: Ref<HTMLElement | null>,
  source: Ref<string> | ComputedRef<string>,
  streaming?: Ref<boolean> | ComputedRef<boolean>,
) {
  const zoom = ref<MermaidZoomState | null>(null)
  const zoomScale = ref(1)
  // Multiplicative steps: the opened diagram is already fitted to the viewport,
  // so a fixed +/- px step would be tiny on big graphs and huge on small ones.
  // The absolute scale limits live in `mountPanZoom` (shared by inline + modal).
  const ZOOM_STEP = 1.25

  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  /** Remove the transient `#d<id>`/`i<id>` nodes mermaid leaves behind on failure. */
  function cleanupArtifacts(): void {
    for (const el of document.querySelectorAll('body > div[id^="dmermaid-"], body > div[id^="d3-"]')) {
      el.remove()
    }
  }

  /**
   * Post-process a freshly injected diagram.
   *
   * Mermaid emits `width="100%"` + `style="max-width: <natural>px"`. With the
   * chat column at 860px, any diagram wider than that got scaled down — and a
   * scaled SVG scales its 16px labels AND its 1px strokes, which is exactly why
   * diagrams looked faint and edges seemed to vanish. So: pin the intrinsic size
   * from the viewBox, expose a horizontal scrollbar in `.mermaid-canvas` instead
   * of shrinking, and let the enlarged view handle "too big".
   */
  function normalizeSvg(canvas: HTMLElement): void {
    const svg = canvas.querySelector('svg')
    if (!svg) return
    const dims = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
    const w = dims.length === 4 ? dims[2] ?? Number.NaN : Number.NaN
    const h = dims.length === 4 ? dims[3] ?? Number.NaN : Number.NaN
    if (Number.isFinite(w) && w > 0) {
      svg.setAttribute('width', String(Math.ceil(w)))
      if (Number.isFinite(h) && h > 0) svg.setAttribute('height', String(Math.ceil(h)))
    }
    svg.style.maxWidth = 'none'
    svg.style.display = 'block'
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')

    // Infinite canvas instead of a scrollbar: the diagram keeps its intrinsic
    // size and the reader drags / wheel-zooms. The viewport height follows the
    // fitted size (capped) so a small diagram doesn't sit in a 600px void.
    panZoomHandles.get(canvas)?.destroy()
    panZoomHandles.delete(canvas)
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      const maxH = Math.min(Math.round(window.innerHeight * 0.62), 620)
      const columnWidth = canvas.clientWidth || w
      const fitScale = Math.max(0.15, Math.min(1, columnWidth / w, maxH / h))
      canvas.style.height = `${Math.max(120, Math.min(maxH, Math.round(h * fitScale)))}px`
      // No measuring here: `mountPanZoom` re-fits itself through its own
      // ResizeObserver the first time the viewport reports a real size, so the
      // first-paint `clientWidth === 0` case cannot pin a wrong scale.
      panZoomHandles.set(canvas, mountPanZoom(canvas, svg, w, h))
      canvas.title = '拖拽移动 · Ctrl/⌘+滚轮缩放 · 双击复位'
    }

    // Mermaid paints node/edge colours as inline `fill:#… !important`, so config
    // (`themeVariables`, even `themeCSS`) cannot override them. Re-apply the
    // palette directly on the nodes after the fact — this is what actually makes
    // a diagram match the app theme instead of importing mermaid's pale palette.
    const vars = diagramThemeVariables(resolveMermaidTheme())
    for (const el of Array.from(
      svg.querySelectorAll('.node rect, .node polygon, .node circle, .node ellipse, .cluster rect'),
    )) {
      const shape = el as SVGElement
      shape.style.setProperty('fill', vars.mainBkg ?? '', 'important')
      shape.style.setProperty('stroke', vars.nodeBorder ?? '', 'important')
    }
    for (const el of Array.from(svg.querySelectorAll('.edgePath path, path.flowchart-link'))) {
      ;(el as SVGElement).style.setProperty('stroke', vars.lineColor ?? '', 'important')
    }
    for (const el of Array.from(svg.querySelectorAll('.node .label, .node text, text.nodeLabel'))) {
      const label = el as SVGElement & { style: CSSStyleDeclaration }
      label.style.setProperty('fill', vars.textColor ?? '', 'important')
      label.style.setProperty('color', vars.textColor ?? '', 'important')
    }
  }

  async function renderPending(): Promise<void> {
    const host = root.value
    if (!host || disposed) return
    const pending = Array.from(
      host.querySelectorAll<HTMLElement>('.mermaid-block[data-mermaid-state="pending"]'),
    )
    if (pending.length === 0) return

    // While the assistant is still streaming, a fence is usually half-written:
    // rendering it would (a) burn a full mermaid parse per pause, (b) flash a
    // broken diagram, (c) then re-layout when the fence closes. So during
    // streaming we park blocks in `waiting` and show the raw source instead;
    // `watch(streaming)` below kicks the real render once the run settles.
    if (streaming?.value) {
      for (const block of pending) block.dataset.mermaidState = 'waiting'
      return
    }

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
    mermaid.initialize(mermaidConfig(theme))

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
        normalizeSvg(canvas)
        block.dataset.mermaidState = 'ready'
        continue
      }

      // Same source already rendered into this block (e.g. the parent re-emitted
      // identical HTML): re-assigning innerHTML would destroy and rebuild the
      // SVG — a visible flash. Skip it.
      if (block.dataset.mermaidSrc === text && block.dataset.mermaidTheme === theme && canvas.querySelector('svg')) {
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
        normalizeSvg(canvas)
        block.dataset.mermaidSrc = text
        block.dataset.mermaidTheme = theme
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

  // Streaming finished → the fences are complete now, render once.
  if (streaming) {
    watch(streaming, (busy) => {
      if (busy) return
      for (const block of root.value?.querySelectorAll<HTMLElement>(
        '.mermaid-block[data-mermaid-state="waiting"]',
      ) ?? []) {
        block.dataset.mermaidState = 'pending'
      }
      schedule()
    })
  }

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
    if (!svgEl) return

    const clone = svgEl.cloneNode(true) as SVGSVGElement
    clone.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    clone.style.maxWidth = 'none'
    clone.style.display = 'block'

    const dims = (svgEl.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
    const rect = svgEl.getBoundingClientRect()
    const vbWidth = dims.length === 4 ? (dims[2] ?? Number.NaN) : Number.NaN
    const vbHeight = dims.length === 4 ? (dims[3] ?? Number.NaN) : Number.NaN
    const naturalWidth = Number.isFinite(vbWidth) && vbWidth > 0 ? vbWidth : rect.width || 800
    const naturalHeight = Number.isFinite(vbHeight) && vbHeight > 0 ? vbHeight : rect.height || 400
    // Native size: the stage pans/zooms it with a transform, so the clone must
    // not be pre-scaled to 100% of the panel (that was the old sizing model).
    clone.setAttribute('width', String(Math.ceil(naturalWidth)))
    clone.setAttribute('height', String(Math.ceil(naturalHeight)))

    zoom.value = { svg: clone.outerHTML, source: blockSource(block), naturalWidth, naturalHeight }
  }

  /** The modal is an infinite canvas too: drag to pan, wheel to zoom, 1:1 button. */
  const zoomStage = ref<HTMLElement | null>(null)
  let stageHandle: PanZoomHandle | null = null

  function mountZoomStage(): void {
    stageHandle?.destroy()
    stageHandle = null
    const stage = zoomStage.value
    const svg = stage?.querySelector('svg') ?? null
    if (!stage || !svg || !zoom.value) return
    stageHandle = mountPanZoom(stage, svg, zoom.value.naturalWidth, zoom.value.naturalHeight, {
      // Fill the panel instead of opening at the cramped chat-column width.
      maxFitScale: 4,
      // The modal owns the screen, so a plain wheel may zoom here (nothing
      // behind it should scroll while it is open).
      wheelAlways: true,
      onScale: (next) => {
        zoomScale.value = +next.toFixed(2)
      },
    })
  }

  watch(zoomStage, () => void nextTick(mountZoomStage), { flush: 'post' })
  watch(zoom, (state) => {
    if (!state) {
      stageHandle?.destroy()
      stageHandle = null
    }
  })

  function closeZoom(): void {
    zoom.value = null
  }

  function zoomIn(): void {
    stageHandle?.zoomBy(ZOOM_STEP)
  }

  function zoomOut(): void {
    stageHandle?.zoomBy(1 / ZOOM_STEP)
  }

  function resetZoom(): void {
    stageHandle?.setScale(1)
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
    zoomStage,
    zoomScale,
    zoomPercent,
    closeZoom,
    zoomIn,
    zoomOut,
    resetZoom,
    copyZoomSource,
  }
}
