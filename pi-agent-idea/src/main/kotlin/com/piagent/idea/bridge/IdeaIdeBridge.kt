package com.piagent.idea.bridge

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.piagent.idea.bridge.methods.BridgeMethods

/**
 * IDE bridge 通用接口实现。
 *
 * 设计：invoke / on / getEnv 三个方法，handler 路由表可扩展（接口稳定）。
 * Vue 端调 invoke(method, params)，handler 返回 BridgeResponse<T>。
 *
 * 错误约定：
 *   - 业务错误：error.code 是稳定字符串（"file_not_found" / "timeout" / "permission_denied"）
 *   - 系统错误：error.code = "internal"
 *   - 未知 method：error.code = "unknown_method"
 */
class IdeaIdeBridge(private val project: Project) {

    data class BridgeResponse<T>(
        val ok: Boolean,
        val data: T? = null,
        val error: BridgeError? = null,
    )

    data class BridgeError(val code: String, val message: String, val details: Any? = null)

    data class EnvInfo(val platform: String, val version: String, val capabilities: List<String>)

    data class OpenFileOptions(
        val line: Int? = null,
        val column: Int? = null,
        val preview: Boolean = false,
    )

    data class OpenFileParams(
        val path: String,
        val options: OpenFileOptions? = null,
    )

    data class EditorContext(
        val filePath: String,
        val startLine: Int,
        val endLine: Int,
        val text: String,
        val language: String? = null,
    )

    data class ThemeInfo(
        val mode: String,           // "light" | "dark" | "high-contrast"
        val cssVars: Map<String, String>,
        val fontFamily: String? = null,
    )

    data class SearchFilesParams(
        val query: String,
        val limit: Int? = null,
    )

    data class SearchFileHit(
        val path: String,           // absolute path
        val label: String,          // basename for display
        val relativePath: String,   // relative to project base
    )

    fun <T> invoke(method: String, params: Any?): BridgeResponse<T> {
        val handler = handlers[method]
            ?: return errFor("unknown_method", "Unknown method: $method")
        return try {
            @Suppress("UNCHECKED_CAST")
            val data = handler.invoke(params) as T
            ok(data)
        } catch (e: Exception) {
            com.piagent.idea.PluginLogger.warn("Bridge invoke failed: method=$method err=${e.javaClass.simpleName}: ${e.message}\n${e.stackTraceToString()}")
            errFor(e.javaClass.simpleName, e.message ?: "Unknown error", e.stackTraceToString())
        }
    }

    /** 路由表：新增 method = 加一行 handler，接口不变。 */
    private val handlers: Map<String, (Any?) -> Any?> = mapOf(
        BridgeMethods.OPEN_FILE         to { handleOpenFile(it) },
        BridgeMethods.REVEAL_IN_PROJECT to { handleRevealInProject(it) },
        BridgeMethods.GET_SELECTION     to { handleGetSelection() },
        BridgeMethods.GET_CURRENT_FILE  to { handleGetCurrentFile() },
        BridgeMethods.GET_WORKSPACE     to { handleGetWorkspace() },
        BridgeMethods.SEARCH_FILES      to { handleSearchFiles(it) },
        BridgeMethods.GET_THEME         to { handleGetTheme() },
        BridgeMethods.NOTIFY            to { handleNotify(it) },
        BridgeMethods.CONFIRM           to { handleConfirm(it) },
    )

    fun getEnv(): BridgeResponse<EnvInfo> = ok(EnvInfo(
        platform = "idea",
        version = PLUGIN_VERSION,
        capabilities = handlers.keys.toList(),
    ))

    // ── handlers ──

    private fun handleOpenFile(params: Any?): Unit {
        val parsed = parseParams(params, OpenFileParams::class.java)
            ?: throw IllegalArgumentException("Invalid openFile params")

        // 相对路径解析为绝对路径（基于 project.basePath）
        val absPath = if (java.nio.file.Paths.get(parsed.path).isAbsolute) {
            parsed.path
        } else {
            val base = project.basePath
                ?: throw IllegalArgumentException("Relative path '${parsed.path}' but no project base path")
            java.nio.file.Paths.get(base, parsed.path).toString()
        }

        val vf = LocalFileSystem.getInstance().findFileByPath(absPath)
            ?: throw IllegalArgumentException("File not found: $absPath")

        val preview = parsed.options?.preview ?: false
        val line0 = (parsed.options?.line ?: 1) - 1
        val col0 = (parsed.options?.column ?: 1) - 1

        ApplicationManager.getApplication().invokeLater {
            val descriptor = OpenFileDescriptor(project, vf, line0, col0)
            FileEditorManager.getInstance(project).openEditor(descriptor, !preview)
        }
    }

    private fun handleRevealInProject(params: Any?): Unit {
        val map = params as? Map<*, *> ?: throw IllegalArgumentException("Expected object params")
        val path = map["path"] as? String ?: throw IllegalArgumentException("Missing path")
        val vf = LocalFileSystem.getInstance().findFileByPath(path)
            ?: throw IllegalArgumentException("File not found: $path")
        ApplicationManager.getApplication().invokeLater {
            FileEditorManager.getInstance(project).openFile(vf, true)
        }
    }

    private fun handleGetSelection(): EditorContext? {
        val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return null
        val sel = editor.selectionModel
        if (!sel.hasSelection()) return null
        val vf = editor.virtualFile ?: return null
        val startLine = sel.selectionStartPosition?.line?.plus(1) ?: 1
        val endLine = sel.selectionEndPosition?.line?.plus(1) ?: 1
        return EditorContext(
            filePath = vf.path,
            startLine = startLine,
            endLine = endLine,
            text = sel.selectedText ?: "",
            language = vf.fileType.name,
        )
    }

    private fun handleGetCurrentFile(): Map<String, Any>? {
        val editor = FileEditorManager.getInstance(project).selectedTextEditor ?: return null
        val vf = editor.virtualFile ?: return null
        return mapOf(
            "path" to vf.path,
            "language" to vf.fileType.name,
            // content omitted (avoid heavy reads on EDT); use file-level APIs if needed
        )
    }

    private fun handleGetWorkspace(): Map<String, Any>? {
        val path = project.basePath ?: return null
        return mapOf(
            "root" to path,
            "name" to project.name,
        )
    }

    /**
     * Search project files by name OR relative path fragment. Returns matches sorted by
     * basename, capped at `limit` (default 20). Per D14: only files, no PSI symbols.
     *
     * Query grammar:
     *   - bare name "README" → matches by basename (FilenameIndex / FS fileName contains)
     *   - relative path "tmp/foo" → splits into dir prefix `tmp/` + name `foo`; PSI path
     *     still indexes by `foo` but additionally requires `relativePath.startsWith("tmp/")`
     *     so we don't surface `src/foo` for a `tmp/foo` query. FS path matches the full
     *     relative path substring (catches paths that PSI can't enumerate yet).
     *
     * Why both halves exist:
     *   - PSI FilenameIndex only matches full basenames, never path fragments. So with
     *     `tmp/foo` we can't ask "give me all files whose path is under tmp/" — we have
     *     to look up `foo` then filter.
     *   - FS fallback runs when PSI returns nothing (index not built yet), and uses
     *     substring match on the full relative path so `tmp/foo` finds files even when
     *     no `foo` exists directly under `tmp/`.
     */
    private fun handleSearchFiles(params: Any?): List<SearchFileHit> {
        val parsed = parseParams(params, SearchFilesParams::class.java)
            ?: throw IllegalArgumentException("Invalid searchFiles params")
        val query = parsed.query.trim()
        if (query.isEmpty()) {
            com.piagent.idea.PluginLogger.info("searchFiles: empty query, return []")
            return emptyList()
        }
        val limit = (parsed.limit ?: 20).coerceAtLeast(0)
        if (limit == 0) return emptyList()

        val basePath = project.basePath
        if (basePath == null) {
            com.piagent.idea.PluginLogger.warn("searchFiles: project.basePath is null, return []")
            return emptyList()
        }
        com.piagent.idea.PluginLogger.info("searchFiles: query='$query' limit=$limit basePath=$basePath")

        // Split query into (dirPrefix, name). For "tmp/foo" → ("tmp/", "foo").
        // For "/tmp/foo" → ("/", "tmp/foo") — the name itself contains a slash,
        // which FilenameIndex can't match (no basename with '/' exists); PSI path
        // returns 0 hits and we fall through to FS, which matches the full path
        // substring correctly.
        val lastSlash = query.lastIndexOf('/')
        val dirPrefix = if (lastSlash >= 0) query.substring(0, lastSlash + 1).lowercase() else ""
        val namePart = if (lastSlash >= 0) query.substring(lastSlash + 1) else query
        if (namePart.isEmpty()) return emptyList()

        val scope = com.intellij.psi.search.GlobalSearchScope.projectScope(project)

        // 1) Try PSI FilenameIndex first (fast, accurate once index is built).
        //    FilenameIndex matches full basenames, so we look up the name part
        //    only — path prefix is enforced as a filter on the resulting hits.
        val psiResults: Collection<com.intellij.openapi.vfs.VirtualFile> = try {
            com.intellij.openapi.application.ApplicationManager
                .getApplication()
                .runReadAction<Collection<com.intellij.openapi.vfs.VirtualFile>> {
                    com.intellij.psi.search.FilenameIndex.getVirtualFilesByName(project, namePart, scope)
                }
        } catch (e: Exception) {
            com.piagent.idea.PluginLogger.warn("searchFiles: PSI index failed: ${e.message}")
            emptyList()
        }
        com.piagent.idea.PluginLogger.info("searchFiles: PSI results=${psiResults.size} for namePart='$namePart' dirPrefix='$dirPrefix'")

        val psiHits = psiResults.asSequence()
            .filter { it.isValid && !it.isDirectory }
            .map { toSearchFileHit(it, basePath) }
            // Apply dir prefix filter only when query contained a "/".
            // Empty dirPrefix (pure-name query) preserves old behavior.
            .filter { dirPrefix.isEmpty() || it.relativePath.lowercase().startsWith(dirPrefix) }
            .sortedBy { it.label.lowercase() }
            .take(limit)
            .toList()

        if (psiHits.isNotEmpty()) return psiHits

        // 2) Fallback: filesystem walk (depth 4). Use the FULL query as a substring
        //    filter against the relative path, not just the fileName — that's the only
        //    way to find a file by intermediate directory (e.g. "tmp/foo" when
        //    `tmp/foo.txt` exists but `foo.txt` only does so under `src/`).
        val fsResults = searchFilesystem(query, limit, basePath)
        com.piagent.idea.PluginLogger.info("searchFiles: FS results=${fsResults.size} for query='$query' (fallback)")
        return fsResults
    }

    private fun toSearchFileHit(vf: com.intellij.openapi.vfs.VirtualFile, basePath: String): SearchFileHit {
        val rel = if (vf.path.startsWith(basePath)) {
            vf.path.substring(basePath.length).trimStart('/', '\\')
        } else {
            vf.path
        }
        return SearchFileHit(path = vf.path, label = vf.name, relativePath = rel)
    }

    private fun searchFilesystem(query: String, limit: Int, basePath: String): List<SearchFileHit> {
        val q = query.lowercase()
        return try {
            java.nio.file.Files.walk(java.nio.file.Paths.get(basePath), 4)
                .filter { java.nio.file.Files.isRegularFile(it) }
                // Substring match against the FULL relative path (forward-slash
                // normalized). Matches by both basename (`"foo"` → `src/foo.txt`)
                // AND path fragment (`"tmp/foo"` → `tmp/sub/foo.txt`), so users
                // can search by intermediate directory.
                .filter { p ->
                    val rel = p.toString()
                        .removePrefix(basePath)
                        .trimStart('/', '\\')
                        .replace('\\', '/')
                        .lowercase()
                    rel.contains(q)
                }
                .limit(limit.toLong())
                .use { stream ->
                    stream.map { p ->
                        SearchFileHit(
                            path = p.toString(),
                            label = p.fileName.toString(),
                            relativePath = p.toString().removePrefix(basePath).trimStart('/', '\\').replace('\\', '/'),
                        )
                    }
                    .sorted(java.util.Comparator.comparing({ hit: SearchFileHit -> hit.label.lowercase() }))
                    .limit(limit.toLong())
                    .toList()
                }
        } catch (e: Exception) {
            emptyList()
        }
    }

    private fun handleGetTheme(): ThemeInfo {
        val isDark = !com.intellij.ui.JBColor.isBright()
        fun toHex(c: java.awt.Color): String = String.format("#%02x%02x%02x", c.red, c.green, c.blue)
        val bg = toHex(com.intellij.ui.JBColor.background())
        val fg = toHex(com.intellij.ui.JBColor.foreground())
        val border = toHex(javax.swing.UIManager.getColor("Component.borderColor") ?: java.awt.Color.GRAY)
        // Per D10: emit 18 cssVars covering all `style.css` references
        // (background / foreground / bubbles / tool cards / result / link / scrollbar / font).
        return ThemeInfo(
            mode = if (isDark) "dark" else "light",
            cssVars = mapOf(
                "--bg-primary" to bg,
                "--text-primary" to fg,
                "--border" to border,
                "--text-secondary" to if (isDark) "#9da0a4" else "#888888",
                // User bubble (blue, consistent across themes)
                "--user-bubble-bg" to "#3577E9",
                "--user-bubble-text" to "#FFFFFF",
                // Tool cards (state-specific; per D10)
                "--tool-done-bg" to if (isDark) "#1B3A1B" else "#E8F5E9",
                "--tool-done-border" to if (isDark) "#66BB6A" else "#4CAF50",
                "--tool-running-bg" to if (isDark) "#3D3A1B" else "#FFF8E1",
                "--tool-running-border" to if (isDark) "#FFC107" else "#FF9800",
                "--tool-error-bg" to if (isDark) "#3D1B1B" else "#FFEBEE",
                "--tool-error-border" to if (isDark) "#EF5350" else "#F44336",
                // Tool result (subtle highlight inside card)
                "--tool-result-bg" to if (isDark) "#274427" else "rgba(0,0,0,0.08)",
                // Link color (blue, matches IDE hyperlink)
                "--link" to if (isDark) "#64B5F6" else "#3577E9",
                // Scrollbar (translucent, theme-aware)
                "--scrollbar-thumb" to if (isDark) "rgba(255,255,255,0.2)" else "rgba(0,0,0,0.15)",
                "--scrollbar-thumb-hover" to if (isDark) "rgba(255,255,255,0.35)" else "rgba(0,0,0,0.25)",
                // Font
                "--font-family" to "JetBrains Mono",
            ),
            fontFamily = "JetBrains Mono",
        )
    }

    private fun handleNotify(params: Any?): Unit {
        val map = params as? Map<*, *> ?: throw IllegalArgumentException("Expected object params")
        val message = map["message"] as? String ?: ""
        val level = map["level"] as? String ?: "info"
        ApplicationManager.getApplication().invokeLater {
            when (level) {
                "error" -> Messages.showErrorDialog(message, "pi-agent-idea")
                "warn"  -> Messages.showWarningDialog(message, "pi-agent-idea")
                else    -> Messages.showInfoMessage(message, "pi-agent-idea")
            }
        }
    }

    private fun handleConfirm(params: Any?): Boolean {
        val map = params as? Map<*, *> ?: throw IllegalArgumentException("Expected object params")
        val message = map["message"] as? String ?: ""
        val result = arrayOf<Boolean?>(null)
        ApplicationManager.getApplication().invokeAndWait {
            result[0] = Messages.showYesNoDialog(message, "pi-agent-idea", null) == 0
        }
        return result[0] ?: false
    }

    // ── helpers ──

    private fun <T> parseParams(params: Any?, type: Class<T>): T? {
        if (params == null) return null
        val mapper = com.fasterxml.jackson.module.kotlin.jacksonObjectMapper()
        return when (params) {
            is String -> mapper.readValue(params, type)
            is Map<*, *> -> mapper.convertValue(params, type)
            else -> mapper.convertValue(params, type)
        }
    }

    private fun <T> ok(data: T): BridgeResponse<T> = BridgeResponse(ok = true, data = data)

    private fun <T> errFor(code: String, message: String, details: Any? = null): BridgeResponse<T> =
        BridgeResponse(ok = false, error = BridgeError(code, message, details))

    companion object {
        // IDEA Plugin 不方便在这里读到 plugin.xml 的 version；
        // MVP 阶段先 hardcode，Phase 2 改成读 plugin.xml
        const val PLUGIN_VERSION = "0.1.0"
    }
}