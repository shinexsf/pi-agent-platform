package com.piagent.idea.paths

import com.intellij.openapi.project.Project

/**
 * IDE 侧路径 ⇄ server 侧路径 的双向映射。
 *
 * ## 为什么需要
 *
 * WSL 开发时同一份文件有两套写法：
 *
 * | 视角 | 路径 |
 * |---|---|
 * | IDEA（Windows 宿主） | `\\wsl.localhost\dev-agent\home\shinexsf\code\pi-agent-platform` |
 * | pi-agent-server（WSL 内） | `/home/shinexsf/code/pi-agent-platform` |
 *
 * `project.basePath` 只会给出 **IDE 侧** 那套。以前插件把它当"通用路径"直接发出去，
 * 于是 WSL 场景下：
 *
 * - `?workspacePath=` 过滤 / `POST /api/agents` —— 服务端 `normalizePath` 把 UNC 串变成
 *   `//wsl.localhost/dev-agent/...`，agent/session 列表永远空，新建 agent 的 cwd 不存在
 *   （`POST /api/agents` 不校验存在性，坏了也不报）。
 * - `ide.openFile` 收到 server 给的 `/home/x` —— Windows 上 `Paths.get("/home/x").isAbsolute`
 *   是 false，会走进相对路径分支，靠"无盘符绝对路径按 UNC share 根解析"的巧合才能打开。
 *
 * ## 约定（跨边界路径一律 server 形态）
 *
 * 跨 bridge / 跨 HTTP 的路径**一律 server 形态**（WSL 场景就是 posix）；
 * 只有真正要碰 IDE 文件系统的那一刻（`ide.openFile` / `ide.revealInProject` /
 * `FileChooser`）才换回 IDE 形态。这样 DB 与 UI 里存的、显示的、模型看到的都是同一套
 * 路径，不需要在两处维护"哪边是哪边"。
 *
 * ## 映射规则（全自动，由 `project.basePath` 推导）
 *
 * - `\\wsl.localhost\<distro>\...` / `\\wsl$\<distro>\...` → UNC share 根就是发行版 `/`，
 *   所以是**整盘级**映射：`\\wsl.localhost\dev-agent\home\x` ⇄ `/home/x`
 * - 其余（本机 Windows 盘符、Linux/macOS）→ 恒等映射，不做任何改写
 *
 * 未覆盖（需要时再加显式映射设置）：项目开在 `C:\...` 但 server 跑在 WSL 里
 * （那需要 `C:` ⇄ `/mnt/c`）。
 */
class PathMapper private constructor(
    /** IDE 侧前缀，无尾分隔符（例：`\\wsl.localhost\dev-agent`）。空串 = 恒等映射。 */
    val localRoot: String,
    /** server 侧前缀（WSL 场景是 `/`）。 */
    val serverRoot: String,
    /** WSL 发行版名；非 WSL 场景为 null。 */
    val distro: String? = null,
) {

    val isIdentity: Boolean get() = localRoot.isEmpty()

    /** IDE 形态 → server 形态。不匹配映射前缀时原样返回（相对路径、盘符路径等）。 */
    fun toServerPath(idePath: String): String {
        if (isIdentity || idePath.isEmpty()) return idePath
        val path = idePath.replace('/', '\\')
        val prefix = localRoot.replace('/', '\\')
        if (!path.startsWith(prefix, ignoreCase = true)) return idePath
        // 边界检查：`\\wsl.localhost\dev-agent2\...` 不能匹配前缀 `\\wsl.localhost\dev-agent`
        if (path.length > prefix.length && path[prefix.length] != '\\') return idePath
        val rel = path.substring(prefix.length).replace('\\', '/').trimStart('/')
        val base = serverRoot.trimEnd('/')
        return if (rel.isEmpty()) serverRoot else "$base/$rel"
    }

    /** server 形态 → IDE 形态。非绝对 posix 路径（相对路径 / 盘符路径）原样返回。 */
    fun toIdePath(serverPath: String): String {
        if (isIdentity || serverPath.isEmpty()) return serverPath
        val path = serverPath.replace('\\', '/')
        val base = serverRoot.trimEnd('/')  // WSL 场景为 ""，即"必须是绝对路径"
        if (path != base && !path.startsWith("$base/")) return serverPath
        val rel = path.removePrefix(base).trimStart('/')
        if (rel.isEmpty()) return localRoot
        return localRoot.replace('/', '\\') + "\\" + rel.replace('/', '\\')
    }

    /** 日志 / 报错用的一句话描述。 */
    fun describe(): String = if (isIdentity) "identity" else "$localRoot <-> $serverRoot"

    companion object {
        val IDENTITY = PathMapper(localRoot = "", serverRoot = "/")

        /** `\\wsl.localhost\<distro>` / `\\wsl$\<distro>`（也接受正斜杠写法）。 */
        private val WSL_UNC = Regex("""^[\\/]{2}([^\\/]+)[\\/]([^\\/]+)""")
        private val WSL_HOSTS = setOf("wsl.localhost", "wsl\$")

        /** 从 `project.basePath` 推导映射；无法推导时返回 [IDENTITY]。 */
        fun detect(projectBasePath: String?): PathMapper {
            val base = projectBasePath?.trim().orEmpty()
            if (base.isEmpty()) return IDENTITY
            val match = WSL_UNC.find(base) ?: return IDENTITY
            val host = match.groupValues[1]
            val distro = match.groupValues[2]
            if (host.lowercase() !in WSL_HOSTS || distro.isBlank()) return IDENTITY
            // 保留项目打开时用的 host 写法（`wsl.localhost` / `wsl$` 都继续用同一套）
            return PathMapper(
                localRoot = "\\\\$host\\$distro",
                serverRoot = "/",
                distro = distro,
            )
        }
    }
}

/** 按 project 取 [PathMapper]。纯函数（只依赖 basePath），不需要缓存也不会过期。 */
object ProjectPaths {
    fun of(project: Project): PathMapper = PathMapper.detect(project.basePath)

    fun of(basePath: String?): PathMapper = PathMapper.detect(basePath)
}
