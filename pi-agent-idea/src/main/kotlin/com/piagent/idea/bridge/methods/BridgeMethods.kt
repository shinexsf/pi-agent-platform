package com.piagent.idea.bridge.methods

/**
 * 与 platform/apps/pi-agent-ide/src/bridge/methods.ts 的 Methods / Events 常量字符串一一对应。
 * 跨语言契约靠集成测试 BridgeContractTest 兜底（specs/ide-bridge-protocol/spec.md）。
 */
object BridgeMethods {
    const val OPEN_FILE = "ide.openFile"
    const val REVEAL_IN_PROJECT = "ide.revealInProject"

    const val GET_SELECTION = "context.getSelection"
    const val GET_CURRENT_FILE = "context.getCurrentFile"
    const val GET_WORKSPACE = "context.getWorkspace"
    const val SEARCH_FILES = "context.searchFiles"

    const val GET_THEME = "theme.get"

    const val NOTIFY = "ui.notify"
    const val CONFIRM = "ui.confirm"
}

object BridgeEvents {
    const val THEME_CHANGED = "theme.changed"
    const val SESSION_QUEUE_UPDATE = "session.queue_update"
    const val WORKSPACE_CHANGED = "context.workspaceChanged"
    const val EDITOR_FOCUSED = "editor.focused"
}