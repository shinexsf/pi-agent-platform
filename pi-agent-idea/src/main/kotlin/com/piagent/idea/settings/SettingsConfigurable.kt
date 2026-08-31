package com.piagent.idea.settings

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBLabel
import com.piagent.idea.PluginLogger
import com.piagent.idea.server.ServerApiClient
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.JTextField

/**
 * Settings UI: 出现在 Settings → Tools → pi-agent-idea。
 */
class SettingsConfigurable : Configurable {

    private val settings = PluginSettings.getInstance()

    private lateinit var serverUrlField: JTextField
    private lateinit var testStatusLabel: JBLabel

    override fun getDisplayName(): String = "pi-agent-idea"

    override fun createComponent(): JPanel {
        val root = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
        }

        // Server URL
        serverUrlField = JTextField(settings.serverUrl, 30)
        root.add(labeled("Server URL:", serverUrlField))

        root.add(Box.createVerticalStrut(8))

        // Test Connection button
        val testButton = JButton("Test Connection").apply {
            addActionListener {
                testStatusLabel.text = "Testing..."
                testStatusLabel.isVisible = true
                val ok = try {
                    ServerApiClient(serverUrlField.text.trim()).healthCheck()
                } catch (e: Exception) {
                    PluginLogger.warn("Test failed: ${e.message}")
                    false
                }
                testStatusLabel.text = if (ok) {
                    "OK - server reachable"
                } else {
                    "FAIL - check URL or server status"
                }
            }
        }
        root.add(testButton)

        testStatusLabel = JBLabel("").apply {
            isVisible = false
        }
        root.add(testStatusLabel)

        return root
    }

    private fun labeled(labelText: String, field: java.awt.Component): JPanel {
        val panel = JPanel()
        panel.layout = BoxLayout(panel, BoxLayout.X_AXIS)
        panel.add(JBLabel(labelText))
        panel.add(Box.createHorizontalStrut(8))
        panel.add(field)
        return panel
    }

    override fun isModified(): Boolean {
        return serverUrlField.text.trim() != settings.serverUrl
    }

    override fun apply() {
        settings.serverUrl = serverUrlField.text.trim()
    }

    override fun reset() {
        serverUrlField.text = settings.serverUrl
        testStatusLabel.isVisible = false
    }
}