package com.piagent.idea.settings

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.piagent.idea.PluginLogger
import com.piagent.idea.server.ServerApiClient
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.JTextField

/**
 * Settings UI: Settings → Tools → pi-agent-idea（**项目级**，`<projectConfigurable>` 会把
 * [Project] 注入到构造函数 —— 只有项目级 configurable 才有这个待遇）。
 *
 * 语义：这里改的是**当前项目**的 server 地址；留空表示继承 IDE 级默认（[PluginSettings]）。
 * 想改"所有新项目的默认值"，用下面的 "Set as IDE default" 按钮。
 */
class SettingsConfigurable(private val project: Project) : Configurable {

    private val settings = ProjectSettings.getInstance(project)
    private val appSettings = PluginSettings.getInstance()

    private lateinit var serverUrlField: JTextField
    private lateinit var inheritHint: JBLabel
    private lateinit var testStatusLabel: JBLabel

    override fun getDisplayName(): String = "pi-agent-idea"

    override fun createComponent(): JPanel {
        val root = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
        }

        serverUrlField = JTextField(settings.serverUrl, 30)
        root.add(labeled("Server URL (this project):", serverUrlField))

        inheritHint = JBLabel("").apply { font = font.deriveFont(font.size2D - 1f) }
        root.add(inheritHint)

        root.add(Box.createVerticalStrut(8))

        val buttons = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
        }
        val testButton = JButton("Test Connection").apply {
            addActionListener {
                testStatusLabel.text = "Testing..."
                testStatusLabel.isVisible = true
                val ok = try {
                    ServerApiClient(serverUrlField.text.trim().ifBlank { appSettings.serverUrl }).healthCheck()
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
        val setDefaultButton = JButton("Set as IDE default").apply {
            toolTipText = "Save this URL as the IDE-wide default inherited by projects that leave the field empty"
            addActionListener {
                val value = serverUrlField.text.trim()
                if (value.isNotBlank()) {
                    appSettings.serverUrl = value
                    refreshHint()
                    testStatusLabel.text = "Saved as IDE default ($value)"
                    testStatusLabel.isVisible = true
                }
            }
        }
        buttons.add(testButton)
        buttons.add(Box.createHorizontalStrut(8))
        buttons.add(setDefaultButton)
        root.add(buttons)

        testStatusLabel = JBLabel("").apply { isVisible = false }
        root.add(testStatusLabel)

        refreshHint()
        return root
    }

    private fun refreshHint() {
        val fallback = appSettings.serverUrl.ifBlank { "(not set)" }
        inheritHint.text = if (settings.serverUrl.isBlank()) {
            "Empty = inherit IDE default: $fallback"
        } else {
            "Overrides the IDE default for this project only (IDE default: $fallback)"
        }
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
        refreshHint()
    }

    override fun reset() {
        serverUrlField.text = settings.serverUrl
        testStatusLabel.isVisible = false
        refreshHint()
    }
}
