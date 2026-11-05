/**
 * 插件宿主（change: plugin-runtime-extensions）。
 *
 * 职责：
 * 1. 从 `GET /api/extensions`（全局菜单/页面）与 `GET /api/sessions/:id/extensions`
 *    （会话级槽位/工具卡片）读**运行期注册表**——不再读 `package.json` 的声明
 * 2. 按需 `import()` 插件入口（`/plugins/<id>/web/<entry>.js`）
 * 3. 给插件一个受控的 `PluginWebHost`，插件自己往容器里渲染
 *
 * 边界：只交换普通 JSON、回调与 DOM 节点；不交换响应式对象或组件。
 */

import type {
  GlobalExtensionsResponse,
  SessionExtensionsResponse,
  WithPlugin,
} from '@pi-agent-platform/api-types'
import type { MenuRegistration, PageRegistration, SurfaceRegistration, ToolCardRegistration } from '@pi-agent-platform/plugin-types'
import type { PluginWebHost, ToolCallSnapshot } from '@pi-agent-platform/plugin-types/web'
import { dispatchPluginEvent, onPluginEvent } from './eventBus'

/** 插件 web 入口导出的契约。 */
export interface PluginWebModule {
  mount(container: HTMLElement, host: PluginWebHost): void | (() => void)
}

/** 用户关闭插件的本地开关；按 pluginId 存。 */
const DISABLED_KEY = 'pi.plugins.disabled'

function readDisabled(): Set<string> {
  try {
    const raw = localStorage.getItem(DISABLED_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return new Set(Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [])
  } catch {
    return new Set()
  }
}

export function isPluginDisabled(pluginId: string): boolean {
  return readDisabled().has(pluginId)
}

export function setPluginDisabled(pluginId: string, disabled: boolean): void {
  const set = readDisabled()
  if (disabled) set.add(pluginId)
  else set.delete(pluginId)
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify([...set]))
  } catch {
    /* 隐私模式下写不进去，忽略 */
  }
}

// ---------- 注册表拉取 ----------

const EMPTY_GLOBAL: GlobalExtensionsResponse = { menus: [], pages: [], disabledByFlag: false }
const EMPTY_SESSION: SessionExtensionsResponse = {
  surfaces: [],
  toolCards: [],
  disabled: {},
  disabledByFlag: false,
}

let cachedGlobal: GlobalExtensionsResponse | null = null
const cachedSession = new Map<string, SessionExtensionsResponse>()

export async function loadGlobalExtensions(force = false): Promise<GlobalExtensionsResponse> {
  if (cachedGlobal && !force) return cachedGlobal
  try {
    const res = await fetch('/api/extensions')
    if (!res.ok) throw new Error(`GET /api/extensions ${res.status}`)
    const body = (await res.json()) as GlobalExtensionsResponse
    cachedGlobal = { ...EMPTY_GLOBAL, ...body }
  } catch (err) {
    console.warn('[plugin] global extensions failed', err)
    cachedGlobal = EMPTY_GLOBAL
  }
  return cachedGlobal
}

export async function loadSessionExtensions(
  sessionId: string | undefined,
  force = false,
): Promise<SessionExtensionsResponse> {
  if (!sessionId) return EMPTY_SESSION
  if (!force) {
    const cached = cachedSession.get(sessionId)
    if (cached) return cached
  }
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/extensions`)
    if (!res.ok) throw new Error(`GET /api/sessions/:id/extensions ${res.status}`)
    const body = (await res.json()) as SessionExtensionsResponse
    const value = { ...EMPTY_SESSION, ...body }
    cachedSession.set(sessionId, value)
    return value
  } catch (err) {
    console.warn('[plugin] session extensions failed', err)
    return EMPTY_SESSION
  }
}

/** 插件安装/启停后清缓存（目录页刷新时调用）。 */
export function invalidatePluginCaches(): void {
  cachedGlobal = null
  cachedSession.clear()
}

/** 全局菜单（导航用）。 */
export async function listPluginMenus(): Promise<Array<WithPlugin<MenuRegistration>>> {
  const body = await loadGlobalExtensions()
  return body.disabledByFlag ? [] : body.menus
}

/** 全局页面定义（插件页路由用）。 */
export async function listPluginPages(): Promise<Array<WithPlugin<PageRegistration>>> {
  const body = await loadGlobalExtensions()
  return body.disabledByFlag ? [] : body.pages
}

/** 拼出插件 web 入口的 URL（server 静态托管）。 */
export function webEntryUrl(pluginId: string, entry: string): string {
  return `/plugins/${encodeURIComponent(pluginId)}/web/${encodeURIComponent(entry)}.js`
}

// ---------- 宿主上下文 ----------

export interface MountHostOptions {
  pluginId: string
  sessionId?: string
  /** 工具卡片上下文（只有卡片挂载点才传）。 */
  toolCard?: {
    snapshot: ToolCallSnapshot
    subscribe(fn: (snapshot: ToolCallSnapshot) => void): () => void
    shell?: PluginWebHost['toolCard'] extends undefined ? never : NonNullable<PluginWebHost['toolCard']>['shell']
  }
}

function resolveTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

/** 极简 toast（不引第三方，样式走 CSS 变量）。 */
function showToast(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  const el = document.createElement('div')
  el.className = `plugin-toast plugin-toast--${kind}`
  el.textContent = message
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2600)
}

/** 底部抽屉：移动端友好；返回关闭函数。 */
function showSheet(options: { title?: string; render: (el: HTMLElement) => void | (() => void) }): () => void {
  const overlay = document.createElement('div')
  overlay.className = 'plugin-sheet-overlay'
  const sheet = document.createElement('div')
  sheet.className = 'plugin-sheet'
  if (options.title) {
    const head = document.createElement('div')
    head.className = 'plugin-sheet-head'
    head.textContent = options.title
    sheet.appendChild(head)
  }
  const body = document.createElement('div')
  body.className = 'plugin-sheet-body'
  sheet.appendChild(body)
  overlay.appendChild(sheet)
  document.body.appendChild(overlay)
  const cleanup = options.render(body)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try {
      if (typeof cleanup === 'function') cleanup()
    } catch (err) {
      console.warn('[plugin] sheet cleanup failed', err)
    }
    overlay.remove()
  }
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  return close
}

async function pluginApi(pluginId: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `/api/p/${encodeURIComponent(pluginId)}${path.startsWith('/') ? path : `/${path}`}`
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(url, init)
  const text = await res.text()
  const contentType = res.headers.get('content-type') ?? ''
  const parsed = contentType.includes('application/json') && text ? (JSON.parse(text) as unknown) : text
  if (!res.ok) {
    throw new Error(`${method} ${url} → ${res.status} ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`)
  }
  return parsed
}

export function createPluginHost(options: MountHostOptions): PluginWebHost {
  const { pluginId, sessionId } = options
  return {
    pluginId,
    sessionId: sessionId ?? '',
    data: {
      subscribe(fn) {
        // 事件总线按 name 分订阅；这里把本插件所有 name 汇总成一个通道。
        // 实现方式：用通配订阅（name 传 '*'）在 eventBus 侧扩展成本高，
        // 这里改为逐个 name 注册——插件在 register 里已声明会用到哪些事件名，
        // 但我们不限制，所以用 '*' 通配匹配。
        return onPluginEvent(pluginId, '*', (payload) => {
          const frame = payload as { name?: unknown; data?: unknown }
          if (typeof frame?.name === 'string') fn({ name: frame.name, data: frame.data })
        })
      },
      emit(name, data) {
        if (!sessionId) {
          console.warn('[plugin] emit ignored: no session context', pluginId, name)
          return
        }
        void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plugins/emit`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pluginId, name, data: data ?? null }),
        }).catch((err) => console.warn('[plugin] emit failed', pluginId, name, err))
      },
    },
    api: {
      blob: (path) =>
        fetch(`/api/p/${encodeURIComponent(pluginId)}${path.startsWith('/') ? path : `/${path}`}`).then((res) => {
          if (!res.ok) throw new Error(`GET blob → ${res.status}`);
          return res.blob();
        }),
      get: (path) => pluginApi(pluginId, 'GET', path),
      post: (path, body) => pluginApi(pluginId, 'POST', path, body),
      put: (path, body) => pluginApi(pluginId, 'PUT', path, body),
      del: (path) => pluginApi(pluginId, 'DELETE', path),
    },
    ui: {
      sheet: showSheet,
      toast: showToast,
    },
    toolCard: options.toolCard
      ? {
          call: options.toolCard.snapshot,
          subscribe: options.toolCard.subscribe,
          shell: options.toolCard.shell ?? (() => ({ body: () => {}, expanded: () => false, onToggle: () => () => {} })),
        }
      : undefined,
    theme: {
      get: resolveTheme,
      subscribe(fn) {
        const observer = new MutationObserver(() => fn(resolveTheme()))
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
        return () => observer.disconnect()
      },
    },
    log(level, message) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      fn(`[plugin:${pluginId}] ${message}`)
    },
  }
}

// ---------- 挂载 ----------

async function importPluginModule(pluginId: string, entry: string): Promise<PluginWebModule> {
  const mod = (await import(/* @vite-ignore */ webEntryUrl(pluginId, entry))) as PluginWebModule
  if (typeof mod.mount !== 'function') throw new Error('web 入口未导出 mount()')
  return mod
}

function createHostElement(pluginId: string, kind: string, target: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = 'plugin-surface'
  el.dataset.pluginId = pluginId
  el.dataset.slot = target
  el.dataset.kind = kind
  return el
}

const mountError = (el: HTMLElement, pluginId: string, err: unknown): void => {
  el.textContent = `插件 ${pluginId} 加载失败`
  el.classList.add('plugin-surface--error')
  console.error('[plugin] mount failed', pluginId, err)
}

/**
 * 挂载某个槽位下的全部插件面板。
 *
 * @param container 宿主提供的容器（插件只能往里画）
 * @returns 卸载函数
 */
export async function mountSlot(
  container: HTMLElement,
  slot: SurfaceRegistration['slot'],
  options: { sessionId?: string; onlyPluginId?: string } = {},
): Promise<() => void> {
  const body = await loadSessionExtensions(options.sessionId)
  const disabled = readDisabled()
  const mounted: Array<() => void> = []
  if (body.disabledByFlag) return () => {}

  for (const surface of body.surfaces) {
    if (surface.slot !== slot) continue
    if (disabled.has(surface.pluginId)) continue
    if (options.onlyPluginId && surface.pluginId !== options.onlyPluginId) continue
    const el = createHostElement(surface.pluginId, 'surface', slot)
    el.dataset.surfaceId = surface.id
    container.appendChild(el)
    try {
      const mod = await importPluginModule(surface.pluginId, surface.entry)
      const cleanup = mod.mount(el, createPluginHost({ pluginId: surface.pluginId, sessionId: options.sessionId }))
      mounted.push(() => {
        try {
          if (typeof cleanup === 'function') cleanup()
        } catch (err) {
          console.warn('[plugin] unmount failed', surface.pluginId, err)
        }
        el.remove()
      })
    } catch (err) {
      mountError(el, surface.pluginId, err)
      mounted.push(() => el.remove())
    }
  }

  return () => {
    for (const unmount of mounted) unmount()
  }
}

/** 右侧轨道（`chat.rail.right`）的可用条目：一个 surface = 一个完整入口。 */
export async function listRailSurfaces(
  sessionId?: string,
): Promise<Array<{ pluginId: string; surface: SurfaceRegistration }>> {
  const body = await loadSessionExtensions(sessionId)
  if (body.disabledByFlag) return []
  const disabled = readDisabled()
  return body.surfaces
    .filter((s) => s.slot === 'chat.rail.right' && !disabled.has(s.pluginId))
    .map((s) => ({ pluginId: s.pluginId, surface: s }))
    .sort((a, b) => (a.surface.order ?? 100) - (b.surface.order ?? 100))
}

/**
 * 挂载一个插件页面（菜单点击后）。
 *
 * 找不到页面定义时返回一个错误卸载函数，页面显示原因而不是白屏。
 */
export async function mountPluginPage(
  container: HTMLElement,
  pluginId: string,
  pageId: string,
): Promise<() => void> {
  const pages = await listPluginPages()
  const page = pages.find((p) => p.pluginId === pluginId && p.id === pageId)
  if (!page) {
    container.textContent = `插件页面不存在：${pluginId} / ${pageId}`
    container.classList.add('plugin-surface--error')
    return () => {}
  }
  const el = createHostElement(pluginId, 'page', pageId)
  container.appendChild(el)
  try {
    const mod = await importPluginModule(pluginId, page.entry)
    const cleanup = mod.mount(el, createPluginHost({ pluginId }))
    return () => {
      try {
        if (typeof cleanup === 'function') cleanup()
      } catch (err) {
        console.warn('[plugin] page unmount failed', pluginId, err)
      }
      el.remove()
    }
  } catch (err) {
    mountError(el, pluginId, err)
    return () => el.remove()
  }
}

/** 找到某个工具的卡片接管声明（会话级）。 */
export function findToolCardRule(
  body: SessionExtensionsResponse,
  toolName: string,
): WithPlugin<ToolCardRegistration> | undefined {
  for (const rule of body.toolCards) {
    if (rule.match === 'prefix' ? toolName.startsWith(rule.tool) : toolName === rule.tool) return rule
  }
  return undefined
}

/** 挂载工具卡片的一段区域或整卡。 */
export async function mountToolCard(
  container: HTMLElement,
  rule: WithPlugin<ToolCardRegistration>,
  entry: string,
  options: {
    sessionId?: string
    snapshot: ToolCallSnapshot
    subscribe: (fn: (snapshot: ToolCallSnapshot) => void) => () => void
    shell?: Parameters<typeof createPluginHost>[0]['toolCard'] extends undefined ? never : NonNullable<Parameters<typeof createPluginHost>[0]['toolCard']>['shell']
  },
): Promise<() => void> {
  const el = createHostElement(rule.pluginId, 'tool-card', entry)
  container.appendChild(el)
  try {
    const mod = await importPluginModule(rule.pluginId, entry)
    const cleanup = mod.mount(
      el,
      createPluginHost({
        pluginId: rule.pluginId,
        sessionId: options.sessionId,
        toolCard: { snapshot: options.snapshot, subscribe: options.subscribe, shell: options.shell },
      }),
    )
    return () => {
      try {
        if (typeof cleanup === 'function') cleanup()
      } catch (err) {
        console.warn('[plugin] tool card unmount failed', rule.pluginId, err)
      }
      el.remove()
    }
  } catch (err) {
    mountError(el, rule.pluginId, err)
    return () => el.remove()
  }
}

/** 把 SSE 的一帧 `plugin` 事件接进总线（useSSE 调用）。 */
export function forwardPluginFrame(payload: string): void {
  try {
    const frame = JSON.parse(payload) as { pluginId?: unknown; name?: unknown; data?: unknown }
    if (typeof frame.pluginId !== 'string' || typeof frame.name !== 'string') return
    // 同时扇出到精确订阅（旧写法）与通配订阅（`data.subscribe`）
    dispatchToBus({ pluginId: frame.pluginId, name: frame.name, data: frame.data })
  } catch (err) {
    console.warn('[plugin] bad frame', err)
  }
}

function dispatchToBus(frame: { pluginId: string; name: string; data?: unknown }): void {
  // dispatchPluginEvent 只按精确 name 分发；这里额外扇出一次 `${pluginId}::*`
  // 让 `data.subscribe` 的通用通道也能收到。
  dispatchPluginEvent(frame)
  dispatchPluginEvent({ pluginId: frame.pluginId, name: '*', data: { name: frame.name, data: frame.data } })
}

