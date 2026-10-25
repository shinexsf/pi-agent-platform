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
 * Blend `color` toward `base` by `amount` (0 = pure base, 1 = pure color).
 * Used to give the diagrams a light accent tint: a diagram that is entirely the
 * page's own surface colour reads as "unstyled", while mermaid's built-in
 * palettes (forest etc.) don't follow the app theme at all. A tint of the brand
 * accent sits in the middle and stays correct in both palettes.
 */
function mixColor(color: string, base: string, amount: number): string {
  const parse = (value: string): [number, number, number] | null => {
    const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1]
    if (hex) {
      const raw = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
      return [
        parseInt(raw.slice(0, 2), 16),
        parseInt(raw.slice(2, 4), 16),
        parseInt(raw.slice(4, 6), 16),
      ]
    }
    const rgb = value.match(/rgba?\(([^)]+)\)/i)?.[1]
    if (!rgb) return null
    const parts = rgb.split(',').map((part) => parseFloat(part.trim()))
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
  }
  const from = parse(color)
  const to = parse(base)
  if (!from || !to) return base
  const channel = (a: number, b: number): string =>
    Math.round(a + (b - a) * (1 - amount)).toString(16).padStart(2, '0')
  return `#${channel(from[0], to[0])}${channel(from[1], to[1])}${channel(from[2], to[2])}`
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
  // Accent tint over the neutral palette (dark mode needs a stronger mix to stay
  // visible against `--surface-raised`).
  const nodeFill = mixColor(accent, surfaceRaised, theme === 'dark' ? 0.18 : 0.10)
  const nodeStroke = mixColor(accent, border, theme === 'dark' ? 0.5 : 0.45)
  const clusterFill = mixColor(accent, surfaceSubtle, theme === 'dark' ? 0.1 : 0.05)
  const line = theme === 'dark' ? '#6b8bbd' : '#8fa0bd'
  return {
    darkMode: String(theme === 'dark'),
    background: surface,
    fontFamily: resolveDiagramFont(),
    fontSize: '14px',
    mainBkg: nodeFill,
    primaryColor: nodeFill,
    primaryTextColor: text,
    primaryBorderColor: nodeStroke,
    secondaryColor: mixColor(accent, surfaceHover, theme === 'dark' ? 0.12 : 0.07),
    secondaryTextColor: text,
    secondaryBorderColor: nodeStroke,
    tertiaryColor: surfaceSubtle,
    tertiaryTextColor: text,
    tertiaryBorderColor: nodeStroke,
    nodeBorder: nodeStroke,
    nodeTextColor: text,
    textColor: text,
    titleColor: text,
    lineColor: line,
    edgeLabelBackground: surface,
    clusterBkg: clusterFill,
    clusterBorder: nodeStroke,
    labelBackground: surface,
    // Sequence / class / state diagrams share these slot names.
    actorBkg: nodeFill,
    actorBorder: nodeStroke,
    actorTextColor: text,
    signalColor: line,
    signalTextColor: text2,
    noteBkg: mixColor(accent, surfaceHover, theme === 'dark' ? 0.12 : 0.07),
    noteBorder: nodeStroke,
    noteTextColor: text,
    labelBoxBkg: nodeFill,
    labelBoxBorder: nodeStroke,
    labelTextColor: text,
    loopTextColor: text,
    activationBkg: surfaceHover,
    activationBorderColor: nodeStroke,
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
  getScale: () => number
  fitScale: () => number
  destroy: () => void
}

/**
 * Infinite-canvas interaction for a diagram: no scrollbars; the content keeps
 * its intrinsic size and is only moved/scaled by a transform. Shrinking an SVG
 * through `max-width` also shrinks its text and hairlines — a 2173px diagram in
 * a 780px column rendered 14px labels at 5px and made edges disappear.
 *
 * Input model (deliberately split in two, per the reference UX):
 * - inline cards: **no wheel handling at all** — zoom via toolbar buttons or a
 *   double-click toggle, drag to pan. Hijacking the wheel inside a message makes
 *   the page feel broken the moment a diagram is under the cursor.
 * - fullscreen: the overlay owns the screen, so a plain wheel zooms.
 */
export function mountPanZoom(
  viewport: HTMLElement,
  content: HTMLElement | SVGElement,
  naturalWidth: number,
  naturalHeight: number,
  opts: {
    maxFitScale?: number
    /** `none` (inline cards), `active` (click-to-enable) or `always` (overlay). */
    wheel?: 'none' | 'active' | 'always'
    /** Double-click behaviour: re-fit, or toggle between fit and a readable zoom. */
    dblclick?: 'fit' | 'toggle'
    onScale?: (scale: number) => void
  } = {},
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
  const fitScale = (): number => {
    const { w, h } = box()
    const target = Math.min(opts.maxFitScale ?? 1, w / natW, h / natH)
    return Math.max(PAN_MIN_SCALE, Math.min(PAN_MAX_SCALE, target))
  }
  // Reader zoom is stored as a multiplier *over* fit, not an absolute scale.
  // Absolute scale broke when the column changed width after the reader had
  // zoomed or panned: the stale scale kept the diagram wider than the box and
  // `overflow: hidden` sliced nodes off the right/bottom edge.
  let userZoom = 1
  let lastWidth = 0
  const clampScale = (value: number): number => Math.max(PAN_MIN_SCALE, Math.min(PAN_MAX_SCALE, value))
  const applyFitWithZoom = (): void => {
    scale = clampScale(fitScale() * userZoom)
    center()
  }
  const fit = (): void => {
    userZoom = 1
    scale = fitScale()
    center()
  }
  const zoomAt = (factor: number, px: number, py: number): void => {
    const next = clampScale(scale * factor)
    if (next === scale) return
    userZoom = next / fitScale()
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
  // Wheel zooms only where it is asked for: never on inline cards, always in
  // the fullscreen overlay. `active` (click into the canvas first) stays
  // available for callers that want the old middle ground.
  const wheelMode = opts.wheel ?? 'active'
  const onWheel = (e: WheelEvent): void => {
    if (wheelMode === 'none') return
    if (!(wheelMode === 'always' || e.ctrlKey || e.metaKey || active)) return
    e.preventDefault()
    interacted = true
    const rect = viewport.getBoundingClientRect()
    const step = e.deltaMode === 1 ? 0.02 : 0.0015
    zoomAt(Math.exp(-e.deltaY * step), e.clientX - rect.left, e.clientY - rect.top)
  }
  const onDoubleClick = (e: MouseEvent): void => {
    e.preventDefault()
    if (opts.dblclick === 'toggle') {
      const base = fitScale()
      // Second double-click returns to fit; first one lands on a readable zoom
      // (roughly 1.8x fit) without needing the toolbar.
      if (scale > base * 1.05) {
        interacted = true
        fit()
      } else {
        interacted = true
        const target = Math.min(PAN_MAX_SCALE, Math.max(base * 1.8, 0.6))
        const { w, h } = box()
        zoomAt(target / scale, w / 2, h / 2)
      }
      return
    }
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
  // Safety net: when the observed size is final on the very first callback, a
  // mount-time fit that ran against a 0-width box would never be corrected and
  // the diagram would sit at natural size, clipped inside the card.
  const lateFit = setTimeout(() => {
    if (content.style.transform) return
    userZoom = 1
    applyFitWithZoom()
  }, 400)
  const observer = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
        // 代码视图 hides the canvas; a 0×0 box would clamp the scale to the
        // minimum and the diagram would come back tiny.
        if (!viewport.clientWidth || !viewport.clientHeight) return
        // A column that changed substantially (drawer opened, window resized,
        // panel splitter) invalidates the reader's zoom ratio — keeping it would
        // leave nodes clipped off the edges. Small jitter (scrollbar, sub-pixel)
        // keeps the zoom.
        const width = viewport.clientWidth
        if (lastWidth && Math.abs(width - lastWidth) / lastWidth > 0.15) userZoom = 1
        lastWidth = width
        applyFitWithZoom()
      })
    : null
  observer?.observe(viewport)

  fit()
  // The first measurement can land before the column has its final width
  // (streaming insertion, drawer animation); re-fit once the frame settles.
  if (typeof requestAnimationFrame !== 'undefined') {
    requestAnimationFrame(() => {
      if (!viewport.clientWidth || !viewport.clientHeight) return
      if (!interacted) applyFitWithZoom()
    })
  }

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
    getScale: () => scale,
    fitScale,
    destroy: () => {
      clearTimeout(lateFit)
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
  /**
   * Mermaid sizes the viewBox from its own text metrics. Those under-estimate
   * wide glyph runs (CJK), and html labels live in a `foreignObject` whose inner
   * div can be wider than the size mermaid declared — in both cases the real
   * content sticks out of the viewBox, and an SVG clips whatever falls outside
   * it. That is the "diagram cut off at the right edge" bug.
   *
   * Measure what is actually laid out and grow the viewBox to cover it.
   * Returns the new box, or null when the original one was already big enough.
   */
  function expandViewBoxToContent(
    svg: SVGSVGElement,
    dims: number[],
  ): { x: number; y: number; w: number; h: number } | null {
    const vbX = dims[0] ?? 0
    const vbY = dims[1] ?? 0
    const vbW = dims[2] ?? 0
    const vbH = dims[3] ?? 0
    let minX = vbX
    let minY = vbY
    let maxX = vbX + vbW
    let maxY = vbY + vbH
    const grow = (x: number, y: number, w: number, h: number): void => {
      if (!Number.isFinite(x) || !Number.isFinite(y) || w <= 0 || h <= 0) return
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + w)
      maxY = Math.max(maxY, y + h)
    }
    const ctm = svg.getScreenCTM()
    // screen px per user unit (handles nested scaling)
    const userPerScreen = ctm ? Math.hypot(ctm.a, ctm.b) || 1 : 1

    for (const el of Array.from(
      svg.querySelectorAll<SVGGraphicsElement>(
        'rect, circle, ellipse, polygon, path, line, text, image, foreignObject',
      ),
    )) {
      if (el.closest('defs, clipPath, marker, pattern, mask, symbol')) continue
      let bb: DOMRect | null = null
      try {
        bb = el.getBBox()
      } catch {
        bb = null
      }
      if (bb) grow(bb.x, bb.y, bb.width, bb.height)
    }
    // html labels: the declared foreignObject box is only mermaid's estimate
    for (const fo of Array.from(svg.querySelectorAll('foreignObject'))) {
      const inner = fo.firstElementChild as HTMLElement | null
      if (!inner) continue
      let bb: DOMRect | null = null
      try {
        bb = (fo as unknown as SVGGraphicsElement).getBBox()
      } catch {
        bb = null
      }
      const baseX = bb ? bb.x : Number(fo.getAttribute('x') ?? 0)
      const baseY = bb ? bb.y : Number(fo.getAttribute('y') ?? 0)
      const needW = (inner.scrollWidth || inner.offsetWidth) / userPerScreen
      const needH = (inner.scrollHeight || inner.offsetHeight) / userPerScreen
      grow(baseX, baseY, Math.max(bb?.width ?? 0, needW), Math.max(bb?.height ?? 0, needH))
    }

    const PAD = 4
    const x = Math.floor(minX - PAD)
    const y = Math.floor(minY - PAD)
    const w = Math.ceil(maxX - minX + PAD * 2)
    const h = Math.ceil(maxY - minY + PAD * 2)
    if (w <= Math.ceil(vbW) + 2 && h <= Math.ceil(vbH) + 2) return null
    svg.setAttribute('viewBox', `${x} ${y} ${w} ${h}`)
    svg.style.overflow = 'visible'
    return { x, y, w, h }
  }

  function normalizeSvg(canvas: HTMLElement): void {
    const svg = canvas.querySelector('svg')
    if (!svg) return
    const dims = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
    const w = dims.length === 4 ? dims[2] ?? Number.NaN : Number.NaN
    const h = dims.length === 4 ? dims[3] ?? Number.NaN : Number.NaN
    // An SVG clips everything outside its viewBox, so a viewBox that mermaid
    // measured a few px too small shows up as content cut off at the right or
    // bottom edge. Grow it to the real content box before fitting.
    let viewW = Number(dims[2])
    let viewH = Number(dims[3])
    if (Number.isFinite(viewW) && Number.isFinite(viewH) && viewW > 0 && viewH > 0) {
      const grown = expandViewBoxToContent(svg, dims)
      if (grown) {
        canvas.dataset.viewBoxGrown = `${Math.round(grown.w - viewW)}x${Math.round(grown.h - viewH)}`
        viewW = grown.w
        viewH = grown.h
      }
    }
    if (Number.isFinite(viewW) && viewW > 0) {
      svg.setAttribute('width', String(Math.ceil(viewW)))
      if (Number.isFinite(viewH) && viewH > 0) svg.setAttribute('height', String(Math.ceil(viewH)))
    }
    svg.style.maxWidth = 'none'
    svg.style.display = 'block'
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')

    // Mermaid 12's `neo` look (the default since 12.0) paints a drop-shadow on
    // every node — a fixed `rgba(185,185,185,1)` halo, i.e. a white glow on a dark
    // page. It arrives three different ways, all of which must go:
    //   1. an inline `style="filter:url(#…-drop-shadow-small)"` on the shape,
    //   2. a `filter="url(#…)"` attribute,
    //   3. (the one that survives naive stripping) a stylesheet *inside the SVG*:
    //      `#id [data-look="neo"].node rect { … filter:drop-shadow(1px 2px 2px …) }`.
    // Removing the rules keeps downloads shadow-free too.
    for (const styleEl of Array.from(svg.querySelectorAll('style'))) {
      const css = styleEl.textContent ?? ''
      if (!css.includes('drop-shadow')) continue
      styleEl.textContent = css.replace(
        /filter:\s*drop-shadow\((?:[^()]|\([^()]*\))*\)\s*;?/g,
        '',
      )
    }
    for (const el of Array.from(svg.querySelectorAll<SVGElement>('*'))) {
      if (el.style.filter) el.style.removeProperty('filter')
      const attr = el.getAttribute('filter')
      if (attr) el.removeAttribute('filter')
    }

    // Infinite canvas instead of a scrollbar: the diagram keeps its intrinsic
    // size and the reader drags / wheel-zooms. The viewport height follows the
    // fitted size (capped) so a small diagram doesn't sit in a 600px void.
    panZoomHandles.get(canvas)?.destroy()
    panZoomHandles.delete(canvas)
    if (Number.isFinite(viewW) && Number.isFinite(viewH) && viewW > 0 && viewH > 0) {
      const maxH = Math.min(Math.round(window.innerHeight * 0.62), 620)
      const columnWidth = canvas.clientWidth || viewW
      const fitScale = Math.max(0.15, Math.min(1, columnWidth / viewW, maxH / viewH))
      canvas.style.height = `${Math.max(120, Math.min(maxH, Math.round(viewH * fitScale)))}px`
      canvas.dataset.naturalWidth = String(Math.ceil(viewW))
      canvas.dataset.naturalHeight = String(Math.ceil(viewH))
      // No measuring here: `mountPanZoom` re-fits itself through its own
      // ResizeObserver the first time the viewport reports a real size, so the
      // first-paint `clientWidth === 0` case cannot pin a wrong scale.
      const block = canvas.closest<HTMLElement>('.mermaid-block')
      panZoomHandles.set(
        canvas,
        mountPanZoom(canvas, svg, viewW, viewH, {
          // Inline cards never take the wheel — the conversation must keep
          // scrolling. Zoom lives in the toolbar / double-click instead.
          wheel: 'none',
          dblclick: 'toggle',
          onScale: (next) => {
            if (block) block.dataset.mermaidScale = String(+next.toFixed(3))
          },
        }),
      )
      canvas.title = '双击放大/还原 · 拖拽移动'
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

  /** Toolbar zoom (inline card): no wheel involved, just buttons. */
  function zoomBlock(block: HTMLElement | null, factor: number): void {
    const canvas = block?.querySelector<HTMLElement>('.mermaid-canvas')
    if (!canvas) return
    panZoomHandles.get(canvas)?.zoomBy(factor)
  }

  function fitBlock(block: HTMLElement | null): void {
    const canvas = block?.querySelector<HTMLElement>('.mermaid-canvas')
    if (!canvas) return
    panZoomHandles.get(canvas)?.fit()
  }

  /**
   * 图表 / 代码 toggle (same affordance as the reference implementation): the
   * source stays in the DOM either way, so switching never re-renders.
   */
  function setBlockView(block: HTMLElement | null, view: 'chart' | 'code'): void {
    if (!block) return
    const canvas = block.querySelector<HTMLElement>('.mermaid-canvas')
    const src = block.querySelector<HTMLElement>('.mermaid-src')
    if (canvas) canvas.hidden = view === 'code'
    if (src) src.hidden = view !== 'code'
    block.dataset.mermaidView = view
    for (const btn of Array.from(block.querySelectorAll<HTMLElement>('.mermaid-view'))) {
      btn.classList.toggle('is-active', btn.dataset.view === view)
    }
  }

  /** Download the diagram as a standalone .svg (what viewers expect to paste). */
  function downloadBlock(block: HTMLElement | null): void {
    const svg = block?.querySelector<SVGSVGElement>('.mermaid-canvas svg')
    if (!svg) return
    const clone = svg.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')
    const canvas = block?.querySelector<HTMLElement>('.mermaid-canvas')
    if (canvas?.dataset.naturalWidth) clone.setAttribute('width', canvas.dataset.naturalWidth)
    if (canvas?.dataset.naturalHeight) clone.setAttribute('height', canvas.dataset.naturalHeight)
    const markup = new XMLSerializer().serializeToString(clone)
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `mermaid-${Date.now()}.svg`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
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
      wheel: 'always',
      dblclick: 'fit',
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
    // inline card controls (toolbar buttons / double-click)
    zoomBlock,
    fitBlock,
    setBlockView,
    downloadBlock,
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
