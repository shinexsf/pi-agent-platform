package com.piagent.idea.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/**
 * 持久化插件配置。
 * 通过 IDEA 的 PersistentStateComponent 机制保存（存到 workspace.xml 或 application-level storage）。
 *
 * MVP 只需要 server URL，不再需要 pi binary path（由 pi-agent-server 接管）。
 */
@Service
@State(name = "PiAgentIdeaPluginSettings", storages = [Storage("pi-agent-idea-plugin.xml")])
class PluginSettings : PersistentStateComponent<PluginSettings.State> {

    data class State(
        var serverUrl: String = "http://localhost:3000",
    )

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    var serverUrl: String
        get() = state.serverUrl
        set(value) { state = state.copy(serverUrl = value) }

    /** server URL 解析后的 host:port，用于 JCEF loadURL。 */
    fun serverOrigin(): String = serverUrl.trimEnd('/')

    fun isConfigured(): Boolean = state.serverUrl.isNotBlank()

    companion object {
        fun getInstance(): PluginSettings =
            ApplicationManager.getApplication().getService(PluginSettings::class.java)
    }
}