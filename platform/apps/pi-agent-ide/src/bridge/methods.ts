/**
 * 约定的 method 名常量。Kotlin 端对应有同名常量 object（BridgeMethods）。
 *
 * ⚠️ 不要在这里改字符串值（会破坏 Kotlin 端契约）。要加新 method = 加一行常量。
 */

export const Methods = {
  // 文件操作
  OPEN_FILE:           'ide.openFile',
  REVEAL_IN_PROJECT:   'ide.revealInProject',

  // 上下文获取
  GET_SELECTION:       'context.getSelection',
  GET_CURRENT_FILE:    'context.getCurrentFile',
  GET_WORKSPACE:       'context.getWorkspace',

  // 主题
  GET_THEME:           'theme.get',

  // 通知
  NOTIFY:              'ui.notify',
  CONFIRM:             'ui.confirm',
} as const

export const Events = {
  THEME_CHANGED:       'theme.changed',
  WORKSPACE_CHANGED:   'context.workspaceChanged',
  EDITOR_FOCUSED:      'editor.focused',
} as const

export type MethodName = typeof Methods[keyof typeof Methods]
export type EventName  = typeof Events[keyof typeof Events]

/** 调用结果的具体类型（按 method 集中放 results.ts 里） */
export namespace Results {
  export type OpenFile       = void
  export type GetSelection   = { filePath: string; startLine: number; endLine: number; text: string; language?: string } | null
  export type GetCurrentFile = { path: string; content?: string; language?: string; isDirty?: boolean } | null
  export type GetWorkspace   = { root: string; git?: { branch: string; remote?: string; commit?: string }; name?: string } | null
  export type GetTheme       = { mode: 'light' | 'dark' | 'high-contrast'; cssVars: Record<string, string>; fontFamily?: string }
  export type Notify         = void
  export type Confirm        = boolean
}