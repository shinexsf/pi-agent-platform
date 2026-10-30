/**
 * 插件事件总线（change: plugin-mechanism 5.4 / 6.2）。
 *
 * 传输层（useSSE）把 server 的 `plugin` 事件原样交给这里，宿主再按
 * `pluginId + name` 分发给订阅者。约定：
 *
 * - 只区分「哪个插件的哪个事件」，不解释载荷
 * - 订阅键是字符串，避免插件 id 里的 `::` 造成歧义（id 用 npm 名，不允许 `::`）
 * - 无订阅者时静默丢弃：插件事件是**尽力而为**的，不是交付保证
 */

export type PluginEventListener = (data: unknown) => void

const listeners = new Map<string, Set<PluginEventListener>>()

const keyOf = (pluginId: string, name: string) => `${pluginId}::${name}`

/** 订阅某个插件事件，返回退订函数。 */
export function onPluginEvent(pluginId: string, name: string, listener: PluginEventListener): () => void {
  const key = keyOf(pluginId, name)
  let set = listeners.get(key)
  if (!set) {
    set = new Set()
    listeners.set(key, set)
  }
  set.add(listener)
  return () => {
    const current = listeners.get(key)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listeners.delete(key)
  }
}

/** 传输层入口：把一帧 `plugin` 事件分发给订阅者。 */
export function dispatchPluginEvent(frame: { pluginId?: unknown; name?: unknown; data?: unknown }): void {
  if (typeof frame.pluginId !== 'string' || typeof frame.name !== 'string') return
  const set = listeners.get(keyOf(frame.pluginId, frame.name))
  if (!set) return
  for (const listener of set) {
    try {
      listener(frame.data)
    } catch (err) {
      // 插件回调抛错不该影响其它订阅者，更不该冒泡到聊天页
      console.warn('[plugin] listener failed', frame.pluginId, frame.name, err)
    }
  }
}

/** 仅供测试/热重载：清空所有订阅。 */
export function resetPluginEvents(): void {
  listeners.clear()
}
