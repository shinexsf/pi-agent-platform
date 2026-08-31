/**
 * 每个 method 的契约文档（JSDoc + 详细 spec）。
 * Kotlin 端对应有同名 data class + KDoc。
 *
 * KOTLIN 端实现位于 ../../../../../pi-agent-idea/src/main/kotlin/com/piagent/idea/bridge/
 */

/**
 * ide.openFile
 *   params: { path: string, options?: { line?: number, column?: number, preview?: boolean, selection?: { start: number, end: number } } }
 *   returns: void
 *   errors: file_not_found | permission_denied | internal
 *   timeout: 5s
 */

/**
 * ide.revealInProject
 *   params: { path: string }
 *   returns: void
 *   errors: file_not_found
 */

/**
 * context.getSelection
 *   params: 无
 *   returns: EditorContext | null（无选区时返回 null，不是错误）
 *   timeout: 1s
 */

/**
 * context.getCurrentFile
 *   params: 无
 *   returns: FileContext | null（无打开文件时返回 null）
 *   timeout: 1s
 *   note: MVP 阶段 content 可能为空（避免大文件读 EDT）
 */

/**
 * context.getWorkspace
 *   params: 无
 *   returns: WorkspaceInfo | null（无项目时返回 null）
 *   timeout: 1s
 */

/**
 * theme.get
 *   params: 无
 *   returns: ThemeInfo
 *   说明: cssVars 是完整的 CSS 变量键值对，调用方负责注入到 :root
 *   timeout: 100ms
 */

/**
 * ui.notify
 *   params: { message: string, level?: 'info' | 'warn' | 'error' }
 *   returns: void
 *   timeout: 1s
 */

/**
 * ui.confirm
 *   params: { message: string }
 *   returns: boolean（用户选 Yes=true / No=false）
 *   timeout: 无（等用户操作）
 */

/**
 * 错误约定
 *   - 业务错误：error.code 是稳定字符串
 *     * "file_not_found" —— 文件路径无效
 *     * "permission_denied" —— 无权限打开
 *     * "timeout" —— 调用超时
 *     * "unsupported_on_<platform>" —— 当前宿主不支持
 *   - 系统错误：error.code = "internal"
 *   - 未知 method：error.code = "unknown_method"
 *
 * 参数序列化约束
 *   - params 只允许 JSON 可序列化纯数据（string / number / boolean / null / array / object）
 *   - 不允许传函数 / Symbol / Date 对象 / class 实例（跨 IPC 边界会断）
 */