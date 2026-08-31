package com.piagent.idea.server

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.piagent.idea.PluginLogger
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * HTTP client for pi-agent-server REST API.
 *
 * MVP 阶段：足够支持 AgentPanel / SessionPanel / Chat tab 容器所需。
 * 用 Jackson 解析 JSON（替代旧插件的 kotlinx.serialization）。
 */
class ServerApiClient(private val serverUrl: String) {

    private val baseUrl: String = serverUrl.trimEnd('/')
    private val mapper: ObjectMapper = jacksonObjectMapper()

    data class Agent(
        val id: String,
        val name: String,
        val description: String?,
        val workspacePath: String,
        val model: String,
        val thinkingLevel: String?,
        // Nullable to match server-side schema (null = "use pi default" for systemPrompt/tools).
        // The IDE plugin only reads these for display + re-edit; the worker side
        // handles the "absent means default" semantics, so leaving these null is safe.
        val systemPrompt: String? = null,
        val appendSystemPrompt: String?,
        val tools: List<String>? = null,
        val createdAt: Long,
        val updatedAt: Long,
    )

    data class Worker(
        val pid: Int,
        val ready: Boolean,
        val uptimeMs: Long,
        val pendingCalls: Int,
    )

    data class Session(
        val id: String,
        val agentId: String,
        val model: String,
        val piSessionPath: String,
        val status: String,  // deprecated but still present
        val title: String?,
        val createdAt: Long,
        val lastActiveAt: Long,
        /** Null when no worker currently running. */
        val worker: Worker?,
        /** Live thinking level (server attaches from workerPool entry; null when no worker). */
        val thinkingLevel: String?,
    )

    /** Raw history JSON (passes through to JCEF as window.__HISTORY__). */
    data class HistoryEnvelope(
        val sessionId: String,
        val messageCount: Int,
        val messages: List<JsonNode>,
    )

    /**
     * Payload for `POST /api/agents` (matches `CreateAgentRequest` on server).
     * Mirrors the shared-types schema so callers don't need to import the package.
     */
    data class CreateAgentPayload(
        val name: String,
        val description: String? = null,
        val workspacePath: String,
        val model: String,
        val thinkingLevel: String? = null,
        val systemPrompt: String = "",
        val appendSystemPrompt: String? = null,
        val tools: List<String> = emptyList(),
    )

    /**
     * Cascade summary returned by [ServerApiClient.deleteAgent]. `errors`
     * is best-effort per-session cleanup messages (e.g. file already gone).
     */
    data class DeleteAgentResponse(
        val deletedSessions: Int = 0,
        val errors: List<String> = emptyList(),
    )

/** Single entry from `GET /api/models`. `displayName` is human-friendly;
     *  `provider/modelId` is what the server accepts as the `model` field. */
    data class ModelOption(
        val provider: String,
        val modelId: String,
        val displayName: String,
    ) {
        /** The `provider/modelId` string stored in agents.model. */
        val value: String get() = "$provider/$modelId"
        // Override the auto-generated toString so JComboBox / JList render
        // "provider/modelId" instead of the verbose "ModelOption(provider=..., modelId=..., displayName=...)".
        // We don't need the data-class toString for debugging — the IDE log
        // shows the constructor args when an exception is thrown anyway.
        override fun toString(): String = value
    }

    fun healthCheck(): Boolean {
        return try {
            val conn = openConnection("$baseUrl/api/health", "GET")
            val ok = conn.responseCode == 200
            conn.disconnect()
            ok
        } catch (e: Exception) {
            PluginLogger.warn("Health check failed: ${e.message}")
            false
        }
    }

    /** List agents whose workspacePath matches (server currently filters server-side via ?workspacePath). */
    fun listAgents(workspacePath: String? = null): List<Agent> {
        val url = if (workspacePath != null) {
            "$baseUrl/api/agents?workspacePath=${URLEncoder.encode(workspacePath, "UTF-8")}"
        } else {
            "$baseUrl/api/agents"
        }
        return try {
            val conn = openConnection(url, "GET")
            val body = readBody(conn)
            conn.disconnect()
            mapper.readTree(body).map { parseAgent(it) }
        } catch (e: Exception) {
            PluginLogger.warn("listAgents failed: ${e.message}")
            emptyList()
        }
    }

    fun listSessions(agentId: String? = null, workspacePath: String? = null): List<Session> {
        // Note: server route reads `agent_id` (snake_case) — must match.
        val params = buildList {
            agentId?.let { add("agent_id=${URLEncoder.encode(it, "UTF-8")}") }
            workspacePath?.let { add("workspacePath=${URLEncoder.encode(it, "UTF-8")}") }
        }
        val url = if (params.isEmpty()) {
            "$baseUrl/api/sessions"
        } else {
            "$baseUrl/api/sessions?${params.joinToString("&")}"
        }
        return try {
            val conn = openConnection(url, "GET")
            val body = readBody(conn)
            conn.disconnect()
            // Server returns { sessions: [...], total, page, pageSize } — unwrap the array.
            mapper.readTree(body).get("sessions")?.map { parseSession(it) } ?: emptyList()
        } catch (e: Exception) {
            PluginLogger.warn("listSessions failed: ${e.message}")
            emptyList()
        }
    }

    /** Create a placeholder session (server does NOT write DB row). */
    fun createPlaceholderSession(agentId: String): String? {
        return try {
            val conn = openConnection("$baseUrl/api/sessions/agents/$agentId", "POST")
            conn.doOutput = true
            conn.outputStream.use { out ->
                out.write("{}".toByteArray(Charsets.UTF_8))
                out.flush()
            }
            val body = readBody(conn)
            conn.disconnect()
            mapper.readTree(body).get("sessionId")?.asText()
        } catch (e: Exception) {
            PluginLogger.warn("createPlaceholderSession failed: ${e.message}")
            null
        }
    }

    /** Fetch history for embedding into JCEF as window.__HISTORY__. */
    fun getSessionMessagesJson(id: String): String? {
        return try {
            val conn = openConnection("$baseUrl/api/sessions/$id/messages", "GET")
            val body = readBody(conn)
            conn.disconnect()
            mapper.readTree(body).get("messages")?.toString()
        } catch (e: Exception) {
            PluginLogger.warn("getSessionMessagesJson failed: ${e.message}")
            null
        }
    }

    /** Per A1 / D9: kill worker without archiving (chat tab closed). Session row stays in DB. */
    fun closeSession(id: String): Boolean {
        return try {
            val conn = openConnection("$baseUrl/api/sessions/$id/close", "POST")
            conn.doOutput = true
            conn.outputStream.use { it.write("{}".toByteArray(Charsets.UTF_8)) }
            val ok = conn.responseCode == 200
            conn.disconnect()
            ok
        } catch (e: Exception) {
            PluginLogger.warn("closeSession failed: ${e.message}")
            false
        }
    }

    /** Per A2: rename session (server `PATCH` → `sessionRepo.update({ title })`). */
    fun renameSession(id: String, title: String): Boolean {
        return try {
            val conn = openConnection("$baseUrl/api/sessions/$id/rename", "POST")
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use {
                val payload = mapper.writeValueAsString(mapOf("title" to title))
                it.write(payload.toByteArray(Charsets.UTF_8))
            }
            val ok = conn.responseCode == 200
            conn.disconnect()
            ok
        } catch (e: Exception) {
            PluginLogger.warn("renameSession failed: ${e.message}")
            false
        }
    }

    /**
     * Create a new agent (matches server `POST /api/agents`).
     * Returns the created Agent on 201.
     * Throws [AgentApiException] on 4xx/5xx so the caller can surface the
     * server's actual error message (e.g. validation failures, missing fields).
     */
    @Throws(AgentApiException::class)
    fun createAgent(payload: CreateAgentPayload): Agent {
        val conn = openConnection("$baseUrl/api/agents", "POST")
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use {
            val body = mapper.writeValueAsString(payload)
            it.write(body.toByteArray(Charsets.UTF_8))
        }
        try {
            if (conn.responseCode !in 200..299) {
                throw AgentApiException(conn.responseCode, extractErrorMessage(conn))
            }
            val resp = readBody(conn)
            return parseAgent(mapper.readTree(resp))
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Update an existing agent (matches server `POST /api/agents/:id`).
     * Returns the updated Agent on 200.
     * Throws [AgentApiException] on 4xx/5xx (e.g. 404 if agent was deleted).
     */
    @Throws(AgentApiException::class)
    fun updateAgent(id: String, payload: CreateAgentPayload): Agent {
        val conn = openConnection("$baseUrl/api/agents/$id", "POST")
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use {
            val body = mapper.writeValueAsString(payload)
            it.write(body.toByteArray(Charsets.UTF_8))
        }
        try {
            if (conn.responseCode !in 200..299) {
                throw AgentApiException(conn.responseCode, extractErrorMessage(conn))
            }
            val resp = readBody(conn)
            return parseAgent(mapper.readTree(resp))
        } finally {
            conn.disconnect()
        }
    }

    /**
     * Read response body and pull the human-readable message from
     * `{ error: "..." }`. Falls back to the raw body if it's not JSON.
     */
    private fun extractErrorMessage(conn: HttpURLConnection): String {
        val body = readBody(conn)
        if (body.isBlank()) return "(empty error body)"
        return try {
            mapper.readTree(body).get("error")?.asText() ?: body
        } catch (_: Exception) {
            body
        }
    }

    /**
     * Fetch the global model registry (provider/modelId/displayName) for the
     * IDE Add-Agent dialog dropdown. Returns empty list on failure.
     */
    fun listAvailableModels(): List<ModelOption> {
        return try {
            val conn = openConnection("$baseUrl/api/models", "GET")
            val body = readBody(conn)
            conn.disconnect()
            val arr = mapper.readTree(body)
            if (!arr.isArray) return emptyList()
            arr.mapNotNull { node ->
                val provider = node.get("provider")?.asText() ?: return@mapNotNull null
                val modelId = node.get("modelId")?.asText() ?: return@mapNotNull null
                val displayName = node.get("displayName")?.asText()
                    ?: "$provider/$modelId"
                ModelOption(provider, modelId, displayName)
            }
        } catch (e: Exception) {
            PluginLogger.warn("listAvailableModels failed: ${e.message}")
            emptyList()
        }
    }

    /**
     * Hard-delete an agent. Server cascades: kills session workers, unlinks
     * pi session files on disk, removes session rows, then deletes the agent.
     * Returns the cascade summary (deleted count + per-session errors), or
     * null on transport failure.
     */
    fun deleteAgent(id: String): DeleteAgentResponse? {
        return try {
            val conn = openConnection("$baseUrl/api/agents/$id/delete", "POST")
            if (conn.responseCode !in 200..299) {
                val errBody = readBody(conn)
                PluginLogger.warn("deleteAgent failed: ${conn.responseCode} ${errBody}")
                conn.disconnect()
                return null
            }
            val resp = readBody(conn)
            conn.disconnect()
            mapper.readTree(resp).let { node ->
                DeleteAgentResponse(
                    deletedSessions = node.get("cascade")?.get("deleted")?.asInt() ?: 0,
                    errors = node.get("cascade")?.get("errors")?.mapNotNull { it.asText() } ?: emptyList(),
                )
            }
        } catch (e: Exception) {
            PluginLogger.warn("deleteAgent failed: ${e.message}")
            null
        }
    }

    /**
     * Hard-delete a session: kills worker (if alive), unlinks pi session file
     * on disk, removes session row.
     */
    fun deleteSession(id: String): Boolean {
        return try {
            val conn = openConnection("$baseUrl/api/sessions/$id/delete", "POST")
            val ok = conn.responseCode in 200..299
            if (!ok) {
                PluginLogger.warn("deleteSession failed: ${conn.responseCode} ${readBody(conn)}")
            }
            conn.disconnect()
            ok
        } catch (e: Exception) {
            PluginLogger.warn("deleteSession failed: ${e.message}")
            false
        }
    }

    /**
     * Register an external pi session file (e.g. from `pi` TUI) into the
     * sessions table without spawning a worker. The server reads the file's
     * header to extract the sessionId, then snapshots the agent's config.
     */
    fun importSessionFromFile(agentId: String, piSessionPath: String, title: String? = null): Session? {
        return try {
            val conn = openConnection("$baseUrl/api/sessions/import-from-file", "POST")
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            val body = mapper.writeValueAsString(
                mapOf("agentId" to agentId, "piSessionPath" to piSessionPath, "title" to title),
            )
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            if (conn.responseCode !in 200..299) {
                val errBody = readBody(conn)
                PluginLogger.warn("importSessionFromFile failed: ${conn.responseCode} ${errBody}")
                conn.disconnect()
                return null
            }
            val resp = readBody(conn)
            conn.disconnect()
            parseSession(mapper.readTree(resp))
        } catch (e: Exception) {
            PluginLogger.warn("importSessionFromFile failed: ${e.message}")
            null
        }
    }

    private fun openConnection(url: String, method: String): HttpURLConnection {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 5000
        conn.readTimeout = 10000
        if (method != "GET") {
            conn.setRequestProperty("Content-Type", "application/json")
        }
        return conn
    }

    private fun readBody(conn: HttpURLConnection): String {
        val stream = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
        return stream?.reader()?.use { it.readText() } ?: ""
    }

    private fun parseAgent(node: JsonNode): Agent = Agent(
        id = node.get("id").asText(),
        name = node.get("name").asText(),
        description = node.get("description")?.takeIf { !it.isNull }?.asText(),
        workspacePath = node.get("workspacePath").asText(),
        model = node.get("model").asText(),
        thinkingLevel = node.get("thinkingLevel")?.takeIf { !it.isNull }?.asText(),
        // systemPrompt / tools became nullable server-side (null = "use pi default").
        // Absent fields surface as null on the wire, so handle defensively.
        systemPrompt = node.get("systemPrompt")?.takeIf { !it.isNull }?.asText(),
        appendSystemPrompt = node.get("appendSystemPrompt")?.takeIf { !it.isNull }?.asText(),
        tools = node.get("tools")?.takeIf { !it.isNull }?.map { it.asText() },
        createdAt = node.get("createdAt").asLong(),
        updatedAt = node.get("updatedAt").asLong(),
    )

    private fun parseSession(node: JsonNode): Session {
        val id = node.get("id")?.asText() ?: return skipSession("missing id")
        val agentId = node.get("agentId")?.asText() ?: return skipSession("missing agentId")
        return Session(
            id = id,
            agentId = agentId,
            model = node.get("model")?.asText() ?: "",
            piSessionPath = node.get("piSessionPath")?.asText() ?: "",
            status = node.get("status")?.asText() ?: "active",
            title = node.get("title")?.takeIf { !it.isNull }?.asText(),
            createdAt = node.get("createdAt")?.asLong() ?: 0L,
            lastActiveAt = node.get("lastActiveAt")?.asLong() ?: 0L,
            worker = node.get("worker")?.takeIf { !it.isNull }?.let {
                Worker(
                    pid = it.get("pid")?.asInt() ?: 0,
                    ready = it.get("ready")?.asBoolean() ?: false,
                    uptimeMs = it.get("uptimeMs")?.asLong() ?: 0L,
                    pendingCalls = it.get("pendingCalls")?.asInt() ?: 0,
                )
            },
            thinkingLevel = node.get("thinkingLevel")?.takeIf { !it.isNull }?.asText(),
        )
    }

    private fun skipSession(reason: String): Session {
        PluginLogger.warn("Skipping malformed session: $reason")
        return Session("", "", "", "", "active", null, 0L, 0L, null, null)
    }
}

/**
 * Thrown by [ServerApiClient.createAgent] / [ServerApiClient.updateAgent]
 * when the server returns a 4xx/5xx response. The UI layer should catch this
 * and show [message] to the user — the server's actual error string is in there.
 */
class AgentApiException(
    val statusCode: Int,
    message: String,
) : RuntimeException("Agent API error $statusCode: $message")