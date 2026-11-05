package com.piagent.idea.settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros
import com.intellij.openapi.project.Project

/**
 * **项目级**插件配置。
 *
 * 跟 [PluginSettings]（应用级 = IDE 全局默认）配合：本项目留空则继承 IDE 级默认值。
 * 这样多项目可以各连各的 server（例如一个项目连 dev `:3000`、另一个连打包态 `:9102`），
 * 新项目又不用每次重填。
 *
 * ⚠️ 存储：写到**项目 workspace.xml**（`StoragePathMacros.WORKSPACE_FILE`），
 * 不写 `.idea/*.xml` —— server 地址是本机个人偏好，不该进 VCS。
 * （之前这个配置挂在 `applicationService` 上、却注册成 `projectConfigurable`，
 * 界面上标着"对本项目生效"，实际改一次所有项目一起变。）
 */
@Service(Service.Level.PROJECT)
@State(
    name = "PiAgentIdeaProjectSettings",
    storages = [Storage(StoragePathMacros.WORKSPACE_FILE)],
)
class ProjectSettings : PersistentStateComponent<ProjectSettings.State> {

    data class State(
        /** 空串 = 继承 IDE 级默认（[PluginSettings.serverUrl]）。 */
        var serverUrl: String = "",
    )

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    /** 本项目显式配置的地址；空 = 继承。 */
    var serverUrl: String
        get() = state.serverUrl
        set(value) { state = state.copy(serverUrl = value.trim()) }

    /** 实际生效的地址（本项目优先，否则 IDE 级默认）。 */
    fun effectiveServerUrl(): String = serverUrl.ifBlank { PluginSettings.getInstance().serverUrl }

    /** 实际生效的 server origin（去掉尾部 `/`，用于 JCEF loadURL 与 HTTP client）。 */
    fun effectiveServerOrigin(): String = effectiveServerUrl().trimEnd('/')

    fun isConfigured(): Boolean = effectiveServerUrl().isNotBlank()

    /** 是否只是继承（本项目没有显式配置）。 */
    fun isInheriting(): Boolean = serverUrl.isBlank()

    companion object {
        fun getInstance(project: Project): ProjectSettings =
            project.getService(ProjectSettings::class.java)
    }
}
