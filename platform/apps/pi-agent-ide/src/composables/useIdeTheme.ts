/**
 * Theme sync composable (per D10).
 *
 * Primary path: Kotlin side injects `window.__applyIdeTheme(themeJson)` and calls it
 * synchronously when bridge is ready AND on every LafManagerListener trigger.
 * This side just provides a Vue-reactive `currentTheme` ref + a fallback for
 * web-only contexts (no bridge).
 */

import { ref } from 'vue'
import type { ThemeInfo } from '../bridge/ide-bridge'

const DEFAULT_DARK_CSS_VARS: Record<string, string> = {
  '--bg-primary': '#191A1C',
  '--text-primary': '#d4d4d4',
  '--text-secondary': '#9da0a4',
  '--border': '#3c3f41',
  '--user-bubble-bg': '#3577E9',
  '--user-bubble-text': '#FFFFFF',
  '--tool-done-bg': '#1B3A1B',
  '--tool-done-border': '#66BB6A',
  '--tool-done-text': '#81C784',
  '--tool-running-bg': '#3D3A1B',
  '--tool-running-border': '#FFC107',
  '--tool-running-text': '#FFCA28',
  '--tool-error-bg': '#3D1B1B',
  '--tool-error-border': '#EF5350',
  '--tool-error-text': '#EF5350',
  '--tool-result-bg': '#274427',
  '--tool-result-bg-error': '#4D2A2A',
  '--tool-result-bg-running': '#5C3F1F',
  '--error-bg': '#3D1F1F',
  '--error-border': '#EF5350',
  '--on-error': '#FFFFFF',
  '--link': '#64B5F6',
  '--scrollbar-thumb': 'rgba(255,255,255,0.2)',
  '--scrollbar-thumb-hover': 'rgba(255,255,255,0.35)',
  '--hover-bg': 'rgba(255,255,255,0.08)',
  '--hover-bg-strong': 'rgba(255,255,255,0.12)',
  '--shadow-popup': '0 -4px 16px rgba(0,0,0,0.4)',
  '--shadow-tooltip': '0 4px 12px rgba(0,0,0,0.5)',
  '--shadow-fab': '0 2px 8px rgba(0,0,0,0.4)',
}

const DEFAULT_LIGHT_CSS_VARS: Record<string, string> = {
  '--bg-primary': '#ffffff',
  '--text-primary': '#24292e',
  '--text-secondary': '#888888',
  '--border': '#e1e4e8',
  '--user-bubble-bg': '#3574F0',
  '--user-bubble-text': '#ffffff',
  '--tool-done-bg': '#E8F5E9',
  '--tool-done-border': '#4CAF50',
  '--tool-done-text': '#1B5E20',
  '--tool-running-bg': '#FFF8E1',
  '--tool-running-border': '#FF9800',
  '--tool-running-text': '#E65100',
  '--tool-error-bg': '#FFEBEE',
  '--tool-error-border': '#F44336',
  '--tool-error-text': '#B71C1C',
  '--tool-result-bg': 'rgba(76,175,80,0.12)',
  '--tool-result-bg-error': '#FFCDD2',
  '--tool-result-bg-running': '#FFE082',
  '--error-bg': '#FFEBEE',
  '--error-border': '#F44336',
  '--on-error': '#B71C1C',
  '--link': '#3574F0',
  '--scrollbar-thumb': 'rgba(0,0,0,0.15)',
  '--scrollbar-thumb-hover': 'rgba(0,0,0,0.25)',
  '--hover-bg': 'rgba(0,0,0,0.06)',
  '--hover-bg-strong': 'rgba(0,0,0,0.10)',
  '--shadow-popup': '0 -4px 16px rgba(0,0,0,0.10)',
  '--shadow-tooltip': '0 4px 12px rgba(0,0,0,0.15)',
  '--shadow-fab': '0 2px 8px rgba(0,0,0,0.12)',
}

export function useIdeTheme() {
  const currentTheme = ref<ThemeInfo | null>(null)
  const applied = ref(false)

  /** Apply theme to document (cssVars + data-mode). Same logic as Kotlin `__applyIdeTheme`. */
  function applyTheme(theme: { mode: string; cssVars: Record<string, string>; fontFamily?: string }) {
    const root = document.documentElement
    for (const key of Object.keys(theme.cssVars)) {
      const value = theme.cssVars[key]
      if (value !== undefined && value !== null) {
        root.style.setProperty(key, value)
      }
    }
    if (theme.fontFamily) {
      root.style.setProperty('--font-family', theme.fontFamily)
    }
    root.setAttribute('data-mode', theme.mode)
    currentTheme.value = theme as ThemeInfo
    applied.value = true
  }

  /** Web-only fallback: use prefers-color-scheme when no bridge is available. */
  function applyBrowserFallbackTheme() {
    const isDark = typeof window !== 'undefined'
      && window.matchMedia
      && window.matchMedia('(prefers-color-scheme: dark)').matches
    applyTheme({
      mode: isDark ? 'dark' : 'light',
      cssVars: isDark ? DEFAULT_DARK_CSS_VARS : DEFAULT_LIGHT_CSS_VARS,
      fontFamily: 'JetBrains Mono',
    })
    console.log('[theme] browser fallback applied (' + (isDark ? 'dark' : 'light') + ')')
  }

  /**
   * Bind: install as fallback handler for `__applyIdeTheme` global (called by Kotlin
   * LafManagerListener push) and also as a safety net if bridge isn't ready.
   *
   * Note: Kotlin side calls `window.__applyIdeTheme(themeJson)` directly via
   * executeJavaScript — NOT through bridge.invoke (which is async and races with
   * listener registration). So this composable is reactive state holder, not the
   * primary path.
   */
  function bindToBridge(): () => void {
    // Kotlin will have already injected __applyIdeTheme — patch it to also update Vue ref
    const origApply = (window as any).__applyIdeTheme
    if (typeof origApply === 'function') {
      (window as any).__applyIdeTheme = (themeJson: any) => {
        origApply(themeJson)
        try {
          const theme = typeof themeJson === 'string' ? JSON.parse(themeJson) : themeJson
          applyTheme(theme)
        } catch (e) {
          console.warn('[theme] bindToBridge applyTheme failed:', e)
        }
      }
    } else {
      // Bridge not injected yet — apply browser fallback so page isn't blank
      applyBrowserFallbackTheme()
    }
    return () => {}
  }

  return {
    currentTheme,
    applied,
    applyTheme,
    bindToBridge,
  }
}