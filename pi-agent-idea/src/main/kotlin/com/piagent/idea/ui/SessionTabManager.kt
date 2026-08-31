package com.piagent.idea.ui

import com.piagent.idea.PluginLogger
import com.piagent.idea.server.ServerApiClient
import java.util.concurrent.ConcurrentHashMap

/**
 * Tracks open chat tabs ↔ sessionId mapping.
 * Handles openSession deduplication and tab close (kill pi).
 */
class SessionTabManager {

    private data class TabEntry(
        val serverSessionId: String,
        val title: String?,
        val onClose: () -> Unit,
    )

    private val tabs = ConcurrentHashMap<String, TabEntry>()

    /**
     * @return existing tab's serverSessionId if already open, else null
     */
    fun isOpen(serverSessionId: String): Boolean = tabs.containsKey(serverSessionId)

    fun register(
        serverSessionId: String,
        title: String?,
        onClose: () -> Unit,
    ) {
        tabs[serverSessionId] = TabEntry(serverSessionId, title, onClose)
        PluginLogger.info("Tab registered: $serverSessionId")
    }

    fun updateTitle(serverSessionId: String, newTitle: String) {
        val entry = tabs[serverSessionId] ?: return
        tabs[serverSessionId] = entry.copy(title = newTitle)
    }

    fun getTitle(serverSessionId: String): String? =
        tabs[serverSessionId]?.title

    /**
     * Closes the tab and triggers the onClose callback (kills pi subprocess).
     * @return true if a tab was closed, false if not found
     */
    fun close(serverSessionId: String): Boolean {
        val entry = tabs.remove(serverSessionId) ?: return false
        PluginLogger.info("Tab closed: $serverSessionId")
        try {
            entry.onClose()
        } catch (e: Exception) {
            PluginLogger.warn("Tab close callback error: ${e.message}")
        }
        return true
    }

    fun openTabIds(): Set<String> = tabs.keys.toSet()

    fun size(): Int = tabs.size

    fun clear() {
        tabs.values.forEach { entry ->
            try { entry.onClose() } catch (_: Exception) {}
        }
        tabs.clear()
    }
}