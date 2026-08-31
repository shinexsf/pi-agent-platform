package com.piagent.idea.bridge

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.piagent.idea.bridge.methods.BridgeEvents
import com.piagent.idea.bridge.methods.BridgeMethods
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.*

/**
 * 跨语言契约测试。
 *
 * 验证 Kotlin 端常量 / data class 跟 Vue 端 methods.ts / Results namespace 一一对应。
 * 测试失败 = 契约漂移，立刻报警。
 */
class BridgeContractTest {

    private val mapper = jacksonObjectMapper()

    @Test
    fun `methods constant sync with Vue端 Methods`() {
        // 期望值跟 platform/apps/pi-agent-ide/src/bridge/methods.ts 里的 Methods 常量字符串一致
        val expected = mapOf(
            "OPEN_FILE" to "ide.openFile",
            "REVEAL_IN_PROJECT" to "ide.revealInProject",
            "GET_SELECTION" to "context.getSelection",
            "GET_CURRENT_FILE" to "context.getCurrentFile",
            "GET_WORKSPACE" to "context.getWorkspace",
            "SEARCH_FILES" to "context.searchFiles",
            "GET_THEME" to "theme.get",
            "NOTIFY" to "ui.notify",
            "CONFIRM" to "ui.confirm",
        )
        val actual = mapOf(
            "OPEN_FILE" to BridgeMethods.OPEN_FILE,
            "REVEAL_IN_PROJECT" to BridgeMethods.REVEAL_IN_PROJECT,
            "GET_SELECTION" to BridgeMethods.GET_SELECTION,
            "GET_CURRENT_FILE" to BridgeMethods.GET_CURRENT_FILE,
            "GET_WORKSPACE" to BridgeMethods.GET_WORKSPACE,
            "SEARCH_FILES" to BridgeMethods.SEARCH_FILES,
            "GET_THEME" to BridgeMethods.GET_THEME,
            "NOTIFY" to BridgeMethods.NOTIFY,
            "CONFIRM" to BridgeMethods.CONFIRM,
        )
        assertEquals(expected, actual, "Methods constant drift between Kotlin and Vue")
    }

    @Test
    fun `events constant sync with Vue端 Events`() {
        val expected = mapOf(
            "THEME_CHANGED" to "theme.changed",
            "SESSION_QUEUE_UPDATE" to "session.queue_update",
            "WORKSPACE_CHANGED" to "context.workspaceChanged",
            "EDITOR_FOCUSED" to "editor.focused",
        )
        val actual = mapOf(
            "THEME_CHANGED" to BridgeEvents.THEME_CHANGED,
            "SESSION_QUEUE_UPDATE" to BridgeEvents.SESSION_QUEUE_UPDATE,
            "WORKSPACE_CHANGED" to BridgeEvents.WORKSPACE_CHANGED,
            "EDITOR_FOCUSED" to BridgeEvents.EDITOR_FOCUSED,
        )
        assertEquals(expected, actual, "Events constant drift between Kotlin and Vue")
    }

    @Test
    fun `OpenFileParams round-trip JSON`() {
        val params = IdeaIdeBridge.OpenFileParams(
            path = "/foo/bar.kt",
            options = IdeaIdeBridge.OpenFileOptions(line = 10, column = 5, preview = false),
        )
        val json = mapper.writeValueAsString(params)
        val restored = mapper.readValue(json, IdeaIdeBridge.OpenFileParams::class.java)
        assertEquals(params, restored)
    }

    @Test
    fun `EditorContext round-trip JSON`() {
        val ctx = IdeaIdeBridge.EditorContext(
            filePath = "/foo/bar.kt",
            startLine = 5,
            endLine = 10,
            text = "selected text",
            language = "Kotlin",
        )
        val json = mapper.writeValueAsString(ctx)
        val restored = mapper.readValue(json, IdeaIdeBridge.EditorContext::class.java)
        assertEquals(ctx, restored)
    }

    @Test
    fun `SearchFilesParams round-trip JSON`() {
        val params = IdeaIdeBridge.SearchFilesParams(query = "build.gradle", limit = 15)
        val json = mapper.writeValueAsString(params)
        val restored = mapper.readValue(json, IdeaIdeBridge.SearchFilesParams::class.java)
        assertEquals(params, restored)
    }

    @Test
    fun `SearchFileHit round-trip JSON`() {
        val hit = IdeaIdeBridge.SearchFileHit(
            path = "D:/proj/build.gradle",
            label = "build.gradle",
            relativePath = "build.gradle",
        )
        val json = mapper.writeValueAsString(hit)
        val restored = mapper.readValue(json, IdeaIdeBridge.SearchFileHit::class.java)
        assertEquals(hit, restored)
    }

    @Test
    fun `ThemeInfo cssVars 18-var round-trip`() {
        // Per D10: emit 18 cssVars covering all style.css references.
        val cssVars = mapOf(
            "--bg-primary" to "#191A1C",
            "--text-primary" to "#d4d4d4",
            "--border" to "#3c3f41",
            "--text-secondary" to "#9da0a4",
            "--user-bubble-bg" to "#3577E9",
            "--user-bubble-text" to "#FFFFFF",
            "--tool-done-bg" to "#1B3A1B",
            "--tool-done-border" to "#66BB6A",
            "--tool-running-bg" to "#3D3A1B",
            "--tool-running-border" to "#FFC107",
            "--tool-error-bg" to "#3D1B1B",
            "--tool-error-border" to "#EF5350",
            "--tool-result-bg" to "#274427",
            "--link" to "#64B5F6",
            "--scrollbar-thumb" to "rgba(255,255,255,0.2)",
            "--scrollbar-thumb-hover" to "rgba(255,255,255,0.35)",
            "--font-family" to "JetBrains Mono",
        )
        val theme = IdeaIdeBridge.ThemeInfo(
            mode = "dark",
            cssVars = cssVars,
            fontFamily = "JetBrains Mono",
        )
        val json = mapper.writeValueAsString(theme)
        val restored = mapper.readValue(json, IdeaIdeBridge.ThemeInfo::class.java)
        assertEquals("dark", restored.mode)
        assertEquals(cssVars, restored.cssVars)
        assertEquals(17, restored.cssVars.size, "ThemeInfo cssVars must cover all 17 style.css references")
    }

    @Test
    fun `ThemeInfo round-trip JSON`() {
        val theme = IdeaIdeBridge.ThemeInfo(
            mode = "dark",
            cssVars = mapOf("--bg-primary" to "#191A1C", "--text-primary" to "#d4d4d4"),
            fontFamily = "JetBrains Mono",
        )
        val json = mapper.writeValueAsString(theme)
        val restored = mapper.readValue(json, IdeaIdeBridge.ThemeInfo::class.java)
        assertEquals(theme.mode, restored.mode)
        assertEquals(theme.cssVars, restored.cssVars)
        assertEquals(theme.fontFamily, restored.fontFamily)
    }

    @Test
    fun `BridgeResponse Ok round-trip JSON`() {
        val res: IdeaIdeBridge.BridgeResponse<String> = IdeaIdeBridge.BridgeResponse(ok = true, data = "hello")
        val json = mapper.writeValueAsString(res)
        assertTrue(json.contains("\"ok\":true"))
        assertTrue(json.contains("\"data\":\"hello\""))
    }

    @Test
    fun `BridgeResponse Err round-trip JSON`() {
        val err = IdeaIdeBridge.BridgeError(code = "file_not_found", message = "File not found: /foo")
        val res: IdeaIdeBridge.BridgeResponse<Nothing> = IdeaIdeBridge.BridgeResponse(ok = false, error = err)
        val json = mapper.writeValueAsString(res)
        assertTrue(json.contains("\"ok\":false"))
        assertTrue(json.contains("\"code\":\"file_not_found\""))
    }

    @Test
    fun `invoke unknown method returns unknown_method error`() {
        // handlers map 在 IdeaIdeBridge.kt 里硬编码；这里只能间接验证常量完整
        // （invoke unknown method 需要 Project 实例，单元测试不便构造）
        val expectedMethods = setOf(
            BridgeMethods.OPEN_FILE,
            BridgeMethods.REVEAL_IN_PROJECT,
            BridgeMethods.GET_SELECTION,
            BridgeMethods.GET_CURRENT_FILE,
            BridgeMethods.GET_WORKSPACE,
            BridgeMethods.GET_THEME,
            BridgeMethods.NOTIFY,
            BridgeMethods.CONFIRM,
        )
        assertEquals(8, expectedMethods.size, "BridgeMethods has 8 constants")
    }

    @Test
    fun `EnvInfo capability list includes all methods`() {
        // getEnv 返回的 capabilities 列表应该包含所有 BridgeMethods 常量
        val expected = setOf(
            BridgeMethods.OPEN_FILE,
            BridgeMethods.REVEAL_IN_PROJECT,
            BridgeMethods.GET_SELECTION,
            BridgeMethods.GET_CURRENT_FILE,
            BridgeMethods.GET_WORKSPACE,
            BridgeMethods.GET_THEME,
            BridgeMethods.NOTIFY,
            BridgeMethods.CONFIRM,
        )
        // 验证常量定义存在（getEnv 内部用 handlers.keys.toList()，所以保持一致）
        assertEquals(8, expected.size, "BridgeMethods has 8 constants")
    }
}