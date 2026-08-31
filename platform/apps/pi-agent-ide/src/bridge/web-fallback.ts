/**
 * web 端 fallback bridge：IDE bridge 未注入时降级。
 * 跟 Kotlin 端 IdeaIdeBridge 实现完全独立的逻辑。
 */

import type { IdeBridge } from './ide-bridge'
import { Methods } from './methods'
import { Ok, Err } from './ide-bridge'

export const webFallbackBridge: IdeBridge = {
  platform: 'web',
  version: '0.0.0',

  invoke: async <T = unknown>(method: string, params?: unknown): Promise<any> => {
    if (method === Methods.GET_THEME) {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      // web fallback 也提供跟 IDE 暗主题一致的调色板，保证视觉风格统一
      return Ok({
        mode: isDark ? 'dark' : 'light',
        cssVars: {
          '--bg-primary': isDark ? '#191A1C' : '#ffffff',
          '--text-primary': isDark ? '#d4d4d4' : '#24292e',
          '--border': isDark ? '#3c3f41' : '#e1e4e8',
          '--text-secondary': isDark ? '#9da0a4' : '#888888',
          '--scrollbar-thumb': isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)',
          '--scrollbar-thumb-hover': isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)',
        },
      })
    }

    if (method === Methods.NOTIFY) {
      const { message } = (params ?? {}) as { message: string }
      console.info('[web notify]', message)
      return Ok(undefined)
    }

    // 其他 method web 端无能力，返回 unsupported_on_web 错误
    return Err('unsupported_on_web', `${method} not supported on web`)
  },

  on: () => {
    // No-op unsubscribe: web fallback has no events to subscribe to.
    console.warn('[webfall] bridge.on() is a no-op outside IDE')
    return () => {}
  },
  getEnv: async () => Ok({
    platform: 'web',
    version: '0.0.0',
    capabilities: [Methods.GET_THEME, Methods.NOTIFY],
  }),
}