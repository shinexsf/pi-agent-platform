/**
 * IDE bridge 通用接口契约（稳定部分）。
 *
 * ⚠️ 接口本身永远不增删方法。新增 IDE 能力 = 在 Methods / Events 常量里加字符串。
 * Kotlin 端对应：pi-agent-idea/src/main/kotlin/com/piagent/idea/bridge/IdeaIdeBridge.kt
 *
 * 同步靠集成测试 BridgeContractTest 兜底（specs/ide-bridge-protocol/spec.md）。
 */

export type BridgeResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

export const Ok = <T>(data: T): BridgeResponse<T> => ({ ok: true, data })
export const Err = (
  code: string,
  message: string,
  details?: unknown,
): BridgeResponse<never> => ({ ok: false, error: { code, message, details } })

export interface EnvInfo {
  platform: string
  version: string
  /** 当前宿主支持的 method 名列表（用于能力发现）*/
  capabilities: string[]
}

/** theme.get 返回的主题信息。Kotlin 端对应 ThemeInfo data class。 */
export interface ThemeInfo {
  mode: 'light' | 'dark' | 'high-contrast'
  cssVars: Record<string, string>
  fontFamily?: string
}

export interface IdeBridge {
  readonly platform: 'web' | 'idea' | 'vscode' | 'unknown'
  readonly version: string

  /** 调用任意能力：method 名 + params，返回 BridgeResponse<T> */
  invoke<T = unknown>(method: string, params?: unknown): Promise<BridgeResponse<T>>

  /** 订阅事件：返回 unsubscribe 函数 */
  on<T = unknown>(event: string, listener: (data: T) => void): () => void

  /** 获取环境信息（platform / version / capabilities）*/
  getEnv(): Promise<BridgeResponse<EnvInfo>>
}

declare global {
  interface Window {
    /** IDE 桥接实现，由宿主注入；未注入时 web 端提供 fallback */
    __ideBridge?: IdeBridge
    __ideBridgeReady?: boolean
  }
}