/**
 * 插件宿主（change: plugin-mechanism 6.1 / 6.2 / 6.6）。
 *
 * 职责只有三件：
 * 1. 从 `GET /api/plugins` 读出「有 web facet 且有槽位」的插件
 * 2. 按需 `import()` 插件的 web 入口（`/plugins/<id>/web/<mountKey>.js`）
 * 3. 把宿主上下文交给插件，插件自己往容器里渲染
 *
 * 边界（设计里定过的，不要越过）：
 * - 宿主**不读**插件的业务数据，`ctx` 里只有 pass-through 能力
 * - 边界两侧只交换普通 JSON / DOM 节点，不交换响应式对象或组件
 * - 插件抛错只让它自己的挂载失败，不影响会话页
 */

import type { PluginEntryDTO, SurfaceRegistration } from '@pi-agent-platform/api-types'
import { dispatchPluginEvent, onPluginEvent } from './eventBus'

/** 插件 web 入口拿到的上下文。 */
export interface PluginWebContext {
  readonly pluginId: string
  readonly slot: SurfaceRegistration['slot']
  /** worker → 浏览器方向的订阅（数据来自 SSE 的 `plugin` 事件）。 */
  on(name: string, listener: (data: unknown) => void): () => void
  /** 浏览器 → worker 方向的上行；失败只记日志，不抛。 */
  emit(name: string, data?: unknown): void
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
}

/** 插件 web 入口导出的契约。 */
export interface PluginWebModule {
  mount(container: HTMLElement, ctx: PluginWebContext): void | (() => void)
}

/** 已挂载实例，便于卸载。 */
interface MountedSurface {
  unmount: () => void
}

/** 用户关闭插件的本地开关（6.6）；按 pluginId 存。 */
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

/** 关闭/开启某个插件在浏览器侧的表现（不卸载 worker facet，只影响 UI）。 */
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

/** 缓存一次列表请求；`force` 用于插件重装后的手动刷新。 */
let cachedEntries: PluginEntryDTO[] | null = null

export async function listPluginEntries(force = false): Promise<PluginEntryDTO[]> {
  if (cachedEntries && !force) return cachedEntries
  try {
    const res = await fetch('/api/plugins')
    if (!res.ok) throw new Error(`GET /api/plugins ${res.status}`)
    const body = (await res.json()) as { plugins?: PluginEntryDTO[] }
    cachedEntries = Array.isArray(body.plugins) ? body.plugins : []
  } catch (err) {
    console.warn('[plugin] list failed', err)
    cachedEntries = []
  }
  return cachedEntries
}

/** 拼出插件 web 入口的 URL（server 静态托管）。 */
export function webEntryUrl(pluginId: string, mountKey: string): string {
  return `/plugins/${encodeURIComponent(pluginId)}/web/${encodeURIComponent(mountKey)}.js`
}

function createContext(pluginId: string, slot: SurfaceRegistration['slot'], sessionId?: string): PluginWebContext {
  return {
    pluginId,
    slot,
    on(name, listener) {
      return onPluginEvent(pluginId, name, listener)
    },
    emit(name, data) {
      if (!sessionId) {
        console.warn('[plugin] emit ignored: no session context', pluginId, name)
        return
      }
      void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plugins/emit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // pluginId 放在 body：npm 包名带 `/`，进路径会被编码掉
        body: JSON.stringify({ pluginId, name, data: data ?? null }),
      }).catch((err) => console.warn('[plugin] emit failed', pluginId, name, err))
    },
    log(level, message) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
      fn(`[plugin:${pluginId}] ${message}`)
    },
  }
}

/**
 * 挂载某个槽位下的全部插件面板。
 *
 * @param container 宿主提供的容器（插件只能往里画，不碰别处）
 * @returns 卸载函数
 */
export async function mountSlot(
  container: HTMLElement,
  slot: SurfaceRegistration['slot'],
  options: { sessionId?: string; onlyPluginId?: string } = {},
): Promise<() => void> {
  const entries = await listPluginEntries()
  const disabled = readDisabled()
  const mounted: MountedSurface[] = []

  for (const entry of entries) {
    if (!entry.facets.web || disabled.has(entry.id)) continue
    if (options.onlyPluginId && entry.id !== options.onlyPluginId) continue
    const surfaces = (entry.slots ?? []).filter((s) => s.slot === slot)
    for (const surface of surfaces) {
      const host = document.createElement('div')
      host.className = 'plugin-surface'
      host.dataset.pluginId = entry.id
      host.dataset.slot = slot
      container.appendChild(host)
      try {
        const mod = (await import(/* @vite-ignore */ webEntryUrl(entry.id, surface.mountKey))) as PluginWebModule
        if (typeof mod.mount !== 'function') throw new Error('web 入口未导出 mount()')
        const cleanup = mod.mount(host, createContext(entry.id, slot, options.sessionId))
        mounted.push({
          unmount: () => {
            try {
              if (typeof cleanup === 'function') cleanup()
            } catch (err) {
              console.warn('[plugin] unmount failed', entry.id, err)
            }
            host.remove()
          },
        })
      } catch (err) {
        console.error('[plugin] mount failed', entry.id, surface.mountKey, err)
        host.textContent = `插件 ${entry.id} 加载失败`
        mounted.push({ unmount: () => host.remove() })
      }
    }
  }

  return () => {
    for (const item of mounted) item.unmount()
  }
}

/**
 * 侧栏图标槽位（`chat.rail-icon`）的可用条目。
 *
 * 宿主自己渲染按钮（图标体系由宿主决定），插件只声明「我是谁、叫什么、排序」。
 */
export async function listRailSurfaces(): Promise<Array<{ pluginId: string; surface: SurfaceRegistration }>> {
  const entries = await listPluginEntries()
  const disabled = readDisabled()
  const out: Array<{ pluginId: string; surface: SurfaceRegistration }> = []
  for (const entry of entries) {
    if (!entry.facets.web || disabled.has(entry.id)) continue
    for (const surface of entry.slots ?? []) {
      if (surface.slot !== 'chat.rail-icon') continue
      // 需要有对应的抽屉面板可开，否则点了没内容
      const hasDrawer = (entry.slots ?? []).some((s) => s.slot === 'chat.drawer')
      if (!hasDrawer) continue
      out.push({ pluginId: entry.id, surface })
    }
  }
  return out.sort((a, b) => (a.surface.order ?? 100) - (b.surface.order ?? 100))
}

/** 把 SSE 的一帧 `plugin` 事件接进总线（useSSE 调用）。 */
export function forwardPluginFrame(payload: string): void {
  try {
    dispatchPluginEvent(JSON.parse(payload) as { pluginId?: unknown; name?: unknown; data?: unknown })
  } catch (err) {
    console.warn('[plugin] bad frame', err)
  }
}
