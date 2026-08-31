# pi-agent-idea IDE Bridge 设计

> 子项目：pi-agent-idea
> 子模块：ide-bridge
> 状态：✅ 已写（已实现）
> 最后更新：2026-08-24

## 目标

让 **JCEF 内运行的 Vue UI** 能调用 **IntelliJ Platform 提供的 IDE 能力**（打开文件、读选区、读当前文件、读 workspace 信息、跟随主题、显示通知等）。

**约束**：

- 跨语言（TypeScript ↔ Kotlin/JVM），不能共享类型
- 接口必须**稳定**，新增功能不能改接口
- 异步 RPC（JCEF ↔ Kotlin bridge handler 是异步的）

## 设计原则

1. **薄接口（thin waist）** —— IdeBridge interface 只有 3 个方法（invoke / on / getEnv），永远不变
2. **method 名路由** —— 新增功能 = 在 `Methods` 常量里加字符串 + 在 Kotlin `handlers` map 里加一行，接口不动
3. **跨语言契约靠源码对齐** —— 不放独立契约包，Kotlin 端读 Vue 项目源码 + 集成测试 round-trip
4. **统一错误返回** —— 所有 invoke 返回 `BridgeResponse<T>`（成功带 data，失败带 error）
5. **web fallback 内置** —— Vue 项目里默认提供 `webFallbackBridge`，IDE bridge 未注入时降级

## 稳定接口

文件位置：`platform/apps/pi-agent-ide/src/bridge/ide-bridge.ts`

```typescript
// ── 稳定部分（接口本身永远不增删方法） ──

export type BridgeResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

export const Ok = <T>(data: T): BridgeResponse<T> => ({ ok: true, data })
export const Err = (code: string, message: string, details?: unknown): BridgeResponse<never> =>
  ({ ok: false, error: { code, message, details } })

export interface EnvInfo {
  platform: string
  version: string
  /** 当前宿主支持的 method 名列表（用于能力发现）*/
  capabilities: string[]
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
```

## method 名约定（可扩展）

文件位置：`platform/apps/pi-agent-ide/src/bridge/methods.ts`

```typescript
/** 约定的 method 名常量。Kotlin 端对应有同名常量 object。 */
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

/** 调用结果的具体类型（按 method 集中放文档里） */
export namespace Results {
  export type OpenFile         = void
  export type GetSelection     = { filePath: string; startLine: number; endLine: number; text: string; language?: string } | null
  export type GetCurrentFile   = { path: string; content: string; language?: string; isDirty?: boolean } | null
  export type GetWorkspace     = { root: string; git?: { branch: string; remote?: string; commit?: string }; name?: string } | null
  export type GetTheme         = { mode: 'light' | 'dark' | 'high-contrast'; cssVars: Record<string, string>; fontFamily?: string }
}
```

## 返回类型文档

文件位置：`platform/apps/pi-agent-ide/src/bridge/results.ts`

```typescript
// 给 IDE bridge 各 method 的详细文档，方便 Kotlin 端对齐
// KOTLIN 端实现位于 ../../../../pi-agent-idea/src/main/kotlin/com/piagent/idea/bridge/

/**
 * ide.openFile
 *   params: { path: string, options?: { line?: number, column?: number, preview?: boolean, selection?: { start: number, end: number } } }
 *   returns: void
 *   errors: file_not_found | permission_denied | timeout
 *   timeout: 5s
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
```

## Vue 端调用示例

文件位置：`platform/apps/pi-agent-ide/src/composables/useIdeBridge.ts`

```typescript
import type { IdeBridge, BridgeResponse } from '../bridge/ide-bridge'
import { webFallbackBridge } from '../bridge/web-fallback'

/** 统一获取 bridge：JCEF 注入的优先，否则 fallback */
export function useIdeBridge(): IdeBridge {
  if (typeof window !== 'undefined' && window.__ideBridge) {
    return window.__ideBridge
  }
  return webFallbackBridge
}
```

文件位置：`platform/apps/pi-agent-ide/src/bridge/web-fallback.ts`

```typescript
import type { IdeBridge } from './ide-bridge'
import { Methods } from './methods'

/** web 端 fallback：bridge 未注入时降级 */
export const webFallbackBridge: IdeBridge = {
  platform: 'web',
  version: '0.0.0',

  invoke: async (method, params) => {
    // 大部分 method web 端无能力，返回 ok + null 表示"无可用能力"
    if (method === Methods.GET_THEME) {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      return { ok: true, data: { mode: isDark ? 'dark' : 'light', cssVars: {} } }
    }
    if (method === Methods.NOTIFY) {
      const { message } = (params ?? {}) as { message: string }
      console.info('[web notify]', message)
      return { ok: true, data: undefined }
    }
    // 其他 method 返回 unknown_method 错误
    return { ok: false, error: { code: 'unsupported_on_web', message: `${method} not supported on web` } }
  },

  on: () => () => {},  // noop unsubscribe
  getEnv: async () => ({ ok: true, data: { platform: 'web', version: '0.0.0', capabilities: [Methods.GET_THEME, Methods.NOTIFY] } }),
}
```

文件位置：`platform/apps/pi-agent-ide/src/components/ChatMessage.tsx`

```typescript
import { useIdeBridge } from '../composables/useIdeBridge'
import { Methods, Results } from '../bridge/methods'

const bridge = useIdeBridge()

// 文件链接点击
async function handleFileLink(path: string, line?: number) {
  const res = await bridge.invoke<void>(Methods.OPEN_FILE, {
    path,
    options: { line },
  })
  if (!res.ok) {
    console.warn('[bridge] openFile failed:', res.error)
  }
}

// "附加当前选区"按钮
async function attachSelection() {
  const res = await bridge.invoke<Results.GetSelection>(Methods.GET_SELECTION)
  if (res.ok && res.data) {
    inputBox.addContext({ type: 'selection', ...res.data })
  }
  // res.ok=false 或 res.data=null 都不报错（web 端无选区是正常）
}

// 主题应用
async function applyIdeTheme() {
  const res = await bridge.invoke<Results.GetTheme>(Methods.GET_THEME)
  if (res.ok) {
    for (const [k, v] of Object.entries(res.data.cssVars)) {
      document.documentElement.style.setProperty(k, v)
    }
  }
}
```

## Kotlin 端实现

文件位置：`pi-agent-idea/src/main/kotlin/com/piagent/idea/bridge/IdeBridge.kt`

```kotlin
package com.piagent.idea.bridge

import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem
import com.piagent.idea.bridge.methods.BridgeMethods
import com.piagent.idea.bridge.methods.BridgeEvents

interface IdeBridge {
    val platform: String
    val version: String
    suspend fun <T> invoke(method: String, params: Any?): BridgeResponse<T>
    fun <T> on(event: String, listener: (T) -> Unit): () -> Unit
    suspend fun getEnv(): BridgeResponse<EnvInfo>
}

data class BridgeResponse<T>(
    val ok: Boolean,
    val data: T? = null,
    val error: BridgeError? = null,
)

data class BridgeError(val code: String, val message: String, val details: Any? = null)

data class EnvInfo(val platform: String, val version: String, val capabilities: List<String>)

fun <T> ok(data: T): BridgeResponse<T> = BridgeResponse(ok = true, data = data)
fun err(code: String, message: String, details: Any? = null): BridgeResponse<Nothing> =
    BridgeResponse(ok = false, error = BridgeError(code, message, details))
```

文件位置：`pi-agent-idea/src/main/kotlin/com/piagent/idea/bridge/methods/BridgeMethods.kt`

```kotlin
// 与 ../../../../../platform/apps/pi-agent-ide/src/bridge/methods.ts 保持同步
object BridgeMethods {
    const val OPEN_FILE = "ide.openFile"
    const val REVEAL_IN_PROJECT = "ide.revealInProject"

    const val GET_SELECTION = "context.getSelection"
    const val GET_CURRENT_FILE = "context.getCurrentFile"
    const val GET_WORKSPACE = "context.getWorkspace"

    const val GET_THEME = "theme.get"

    const val NOTIFY = "ui.notify"
    const val CONFIRM = "ui.confirm"
}

object BridgeEvents {
    const val THEME_CHANGED = "theme.changed"
    const val WORKSPACE_CHANGED = "context.workspaceChanged"
    const val EDITOR_FOCUSED = "editor.focused"
}
```

文件位置：`pi-agent-idea/src/main/kotlin/com/piagent/idea/bridge/IdeaIdeBridge.kt`

```kotlin
class IdeaIdeBridge(private val project: Project) : IdeBridge {
    override val platform = "idea"
    override val version = PluginVersion.VERSION

    override suspend fun <T> invoke(method: String, params: Any?): BridgeResponse<T> {
        return try {
            @Suppress("UNCHECKED_CAST")
            val data = handlers[method]?.invoke(params)
                ?: return err("unknown_method", "Unknown method: $method")
            ok(data as T)
        } catch (e: Exception) {
            err(e.javaClass.simpleName, e.message ?: "Unknown error", e.stackTraceToString())
        }
    }

    // 路由表：新增功能 = 加一行 handler，不用改接口
    private val handlers: Map<String, (Any?) -> Any?> = mapOf(
        BridgeMethods.OPEN_FILE          to { handleOpenFile(it) },
        BridgeMethods.REVEAL_IN_PROJECT  to { handleRevealInProject(it) },
        BridgeMethods.GET_SELECTION      to { handleGetSelection() },
        BridgeMethods.GET_CURRENT_FILE   to { handleGetCurrentFile() },
        BridgeMethods.GET_WORKSPACE      to { handleGetWorkspace() },
        BridgeMethods.GET_THEME          to { handleGetTheme() },
        BridgeMethods.NOTIFY             to { handleNotify(it) },
        BridgeMethods.CONFIRM            to { handleConfirm(it) },
    )

    override fun <T> on(event: String, listener: (T) -> Unit): () -> Unit {
        return when (event) {
            BridgeEvents.THEME_CHANGED -> subscribeThemeChanges(listener)
            BridgeEvents.WORKSPACE_CHANGED -> subscribeWorkspaceChanges(listener)
            else -> { {} }  // 未知事件返回 noop unsubscribe
        }
    }

    override suspend fun getEnv(): BridgeResponse<EnvInfo> = ok(EnvInfo(
        platform = "idea",
        version = PluginVersion.VERSION,
        capabilities = handlers.keys.toList(),
    ))

    // ── handler 实现 ──

    private fun handleOpenFile(params: Any?): Unit {
        val (path, options) = parseOpenFileParams(params)
        val vf = LocalFileSystem.getInstance().findFileByPath(path)
            ?: throw IllegalArgumentException("File not found: $path")

        ReadAction.run<Throwable> {
            val editor = FileEditorManager.getInstance(project)
                .openFile(vf, !(options?.preview ?: false))
            options?.line?.let { line ->
                val logicalLine = line - 1  // IDE 0-based
                val logicalCol = (options.column ?: 1) - 1
                editor?.caretModel?.moveToLogicalPosition(LogicalPosition(logicalLine, logicalCol))
            }
        }
    }

    private fun handleGetSelection(): EditorContext? {
        val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return null
        val selection = editor.selectionModel
        if (!selection.hasSelection()) return null
        return EditorContext(
            filePath = editor.virtualFile.path,
            startLine = selection.selectionStartPosition.line + 1,
            endLine = selection.selectionEndPosition.line + 1,
            text = selection.selectedText ?: "",
            language = editor.virtualFile.fileType.name,
        )
    }

    private fun handleGetTheme(): ThemeInfo {
        val isDark = !JBColor.isBright()
        return ThemeInfo(
            mode = if (isDark) "dark" else "light",
            cssVars = mapOf(
                "--bg-primary" to JBColor.background().toHex(),
                "--text-primary" to JBColor.foreground().toHex(),
                // ... 把 IDE 主题关键色都注入
            ),
            fontFamily = "JetBrains Mono",  // 或读 IDE 配置
        )
    }

    // ... 其他 handler
}
```

## JCEF 注入机制

文件位置：`pi-agent-idea/src/main/kotlin/com/piagent/idea/ui/JcefChatPanel.kt`

```kotlin
class JcefChatPanel(private val project: Project) : Disposable {
    private val bridge = IdeaIdeBridge(project)
    private lateinit var browser: JBCefBrowser
    private val query = JBCefJSQuery.create(browser)

    init {
        // JBCefJSQuery handler：接收来自 JS 的桥接调用
        query.addHandler { jsonString ->
            val req = parseJsRequest(jsonString)
            // 在 coroutine 里 invoke（避免阻塞 EDT）
            scope.launch {
                    val res = bridge.invoke<Any>(req.method, req.params)
                    val json = serializeBridgeResponse(res)
                    browser.cefBrowser.executeJavaScript(
                        "__ideBridgeResolve('${req.id}', ${json});",
                        browser.cefBrowser.url, 0
                    )
                }
                null  // 返回 null 表示异步响应（JS 端用 Promise resolve）
        }

        browser = JBCefBrowser.createBuilder()
            .setUrl("http://localhost:${ServerConfig.port}/ide/?sessionId=${sessionId}&agentId=${agentId}&source=idea")
            .build()

        // 等待页面加载完成后注入 bridge
        browser.cefBrowser.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadingStateChange(browser: CefBrowser?, isLoading: Boolean, canGoBack: boolean, canGoForward: boolean) {
                if (!isLoading) {
                    injectBridge()
                }
            }
        })
    }

    private fun injectBridge() {
        browser.cefBrowser.executeJavaScript(
            """
            window.__ideBridge = {
                platform: 'idea',
                version: '${PluginVersion.VERSION}',
                invoke: (method, params) => new Promise((resolve, reject) => {
                    const id = '__bridge_' + Date.now() + '_' + Math.random().toString(36).slice(2);
                    window.__ideBridgeCallbacks = window.__ideBridgeCallbacks || {};
                    window.__ideBridgeCallbacks[id] = { resolve, reject };
                    ${query.inject("JSON.stringify({id: id, method: method, params: params})")};
                }),
                on: (event, listener) => {
                    // 实现：把 listener 注册到本地 map，桥接推送时调用
                    return ${query.inject("JSON.stringify({op:'on', event: event})")};
                },
                getEnv: () => new Promise((resolve, reject) => {
                    const id = '__bridge_env_' + Date.now();
                    window.__ideBridgeCallbacks[id] = { resolve, reject };
                    ${query.inject("JSON.stringify({op:'getEnv', id: id})")};
                }),
            };
            window.__ideBridgeReady = true;
            window.dispatchEvent(new CustomEvent('ide-bridge-ready'));
            """.trimIndent(),
            browser.cefBrowser.url, 0
        )
    }

    override fun dispose() {
        query.dispose()
        browser.dispose()
    }
}
```

### 关键点（避免旧插件踩过的坑）

- ❌ `window.cefQuery({...})` —— `window.cefQuery` 不存在！
- ✅ `query.inject("...")` 生成 JS 表达式字符串，把数据路由到 Kotlin handler
- ✅ 注入必须在**页面加载完成后**（监听 `onLoadingStateChange(isLoading=false)` 或自定义 ready 协议）
- ✅ Promise 模式：JS 端注册 callback id → Kotlin handler 异步响应 → 通过 `executeJavaScript` 调 `__ideBridgeResolve(id, result)` 触发 resolve
- ✅ query handler 返回 `null`（异步响应），不要在 handler 里同步处理阻塞逻辑

## 主题注入流程

```
1. IDE 切换主题（用户手动 / 系统切换）
   ↓
2. LafManagerListener 触发（Kotlin 订阅）
   ↓
3. bridge.getTheme() 拿到新 ThemeInfo
   ↓
4. browser.cefBrowser.executeJavaScript(
     "window.__ideBridgeOnThemeChanged(${serialize(theme)});",
     url, 0
   )
   ↓
5. JS 端 __ideBridgeOnThemeChanged(theme) 被调用
   ↓
6. for ([k, v] of Object.entries(theme.cssVars)) {
     document.documentElement.style.setProperty(k, v)
   }
   ↓
7. CSS variables 变化 → Vue 组件响应式更新
```

## 跨语言契约同步策略

**为什么不放独立契约包**：避免"过度抽象"（决策 D7=C 的延伸）。代价是契约同步靠人工 + 测试。

**同步手段**：

1. **源码对照**（人工 review）
   - Kotlin 端常量 object 跟 Vue 端 `Methods` 常量字符串一一对应
   - Kotlin 端 data class 跟 Vue 端 `Results` 类型一一对应
   - 改一边必须同时改另一边

2. **集成测试**（自动化）
   - 在 `pi-agent-idea/src/test/kotlin/com/piagent/idea/bridge/` 下写：
     ```kotlin
     class BridgeContractTest {
         @Test fun `all methods in Methods constant have handler`() {
             val expected = setOf("ide.openFile", "ide.revealInProject", ...)
             val actual = IdeaIdeBridge(project).handlers.keys
             assertEquals(expected, actual)
         }

         @Test fun `openFile params round-trip JSON`() {
             val params = OpenFileParams(path = "/foo/bar.kt", options = OpenFileOptions(line = 10, column = 5))
             val json = jacksonObjectMapper().writeValueAsString(params)
             // 验证 Kotlin 端能解析从 Vue 端发来的 JSON
             assertEquals(params, jacksonObjectMapper().readValue(json, OpenFileParams::class.java))
         }
     }
     ```
   - 测试失败 = 契约漂移，立刻报警

3. **契约文档注释**（人工对照）
   - `results.ts` 里每个 method 的 JSDoc 是契约描述
   - Kotlin 端 `IdeaIdeBridge.kt` 每个 handler 的 KDoc 是同样描述
   - 改一边必须同步另一边注释

## 错误约定

- **业务错误**：`error.code = "xxx"`（稳定字符串），`error.message = "..."`（人类可读）
- **系统错误**：`error.code = "internal"`，`error.message` 是技术细节
- **超时**：`error.code = "timeout"`
- **不支持**：`error.code = "unknown_method"` / `"unsupported_on_<platform>"`

**禁止**：
- ❌ 用具体异常类名当 error code（跨语言不可控）
- ❌ 在 params 里传函数 / Symbol / Date 对象（跨 IPC 边界会断）

## 性能与超时

| method | 建议超时 |
|---|---|
| `theme.get` | 100ms（必须快，否则页面闪烁）|
| `context.getSelection` | 1s |
| `context.getCurrentFile` | 1s（大文件可能慢） |
| `context.getWorkspace` | 1s |
| `ide.openFile` | 5s（编辑器加载可能慢）|
| `ui.notify` | 1s |
| `ui.confirm` | **无超时**（等用户操作）|

## Open Questions

- **OQ1：单向推送事件（on）的实现** —— JS 端 `on(event, listener)` 注册 listener，Kotlin 端需要推时调 `__ideBridgeOnEvent(event, data)`。需要解决 listener ID 管理和 unsubscribe 的 JS↔Kotlin 映射。当前设计是单向简单版本，复杂场景（高频事件、listener 清理）需要进一步设计。
- **OQ2：桥接失败时的 Vue 降级** —— invoke 返回 ok=false 时，UI 应该显示 fallback 还是 toast 提示？
- **OQ3：bridge 调用是否需要授权层** —— 是否所有 invoke 都要做用户权限确认？MVP 暂不做

## 相关条目

- [`pi-agent-idea_overview.md`](pi-agent-idea_overview.md) —— 整体架构 + 数据流 + 阶段化路径
- 参考旧实现（不迁移）：`reference/projects/personal-agent-manage/agent-manage-plugin/doc/dev-journal/04-pi-rpc-and-js-bridge.md`
- 参考旧实现（不迁移）：`reference/projects/personal-agent-manage/agent-manage-plugin/doc/notes/03-architecture-gap-after-refactor.md`