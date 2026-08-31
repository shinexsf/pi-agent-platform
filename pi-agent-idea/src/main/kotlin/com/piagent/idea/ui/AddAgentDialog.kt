package com.piagent.idea.ui

import com.piagent.idea.PluginLogger
import com.piagent.idea.server.AgentApiException
import com.piagent.idea.server.ServerApiClient
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.Frame
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JDialog
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTextArea
import javax.swing.JTextField
import javax.swing.SwingUtilities

/**
 * Modal dialog for creating OR editing an Agent from inside the IDE plugin.
 *
 * In Create mode (existing == null), the dialog is pre-populated only with the
 * project's basePath (workspacePath, locked). All other fields start empty.
 *
 * In Edit mode (existing != null), every field is pre-populated from the
 * existing Agent. The workspacePath is still locked to the project's path
 * (a row created for project A can never be silently redirected to project B).
 *
 * Field set mirrors the server `CreateAgentRequest` schema:
 *   - name (required)
 *   - description (optional)
 *   - workspacePath (required; locked)
 *   - model (required; dropdown from /api/models, type-fallback if registry fetch fails)
 *   - thinkingLevel (default off; off / low / medium / high)
 *   - systemPrompt (optional)
 *   - appendSystemPrompt (optional)
 *   - tools (optional, comma-separated)
 *
 * On success the dialog closes, calls [onSaved] with the saved Agent so the
 * caller can refresh its list.
 */
class AddAgentDialog(
    owner: Frame,
    private val client: ServerApiClient,
    private val defaultWorkspacePath: String,
    private val existing: ServerApiClient.Agent? = null,
    private val onSaved: (ServerApiClient.Agent) -> Unit,
) : JDialog(owner, if (existing == null) "Add Agent" else "Edit Agent", true) {

    private val nameField = JTextField(24)
    // Model dropdown — populated async from GET /api/models. Holds the model
    // strings in `provider/modelId` form (what the server expects) and shows
    // the human-readable displayName. isEditable as a safety net for when the
    // registry fetch fails — user can still type the value by hand.
    private val modelCombo = JComboBox<ServerApiClient.ModelOption>().apply {
        isEditable = true
        // Force combobox to take a sensible width — default preferredSize is tiny.
        preferredSize = Dimension(360, 28)
    }
    private val descriptionArea = JTextArea(3, 24)
    // First option (off) is selected by default — the empty-string slot was
    // unhelpful: it made the dropdown look empty on open and let the field
    // silently persist as "" on submit. off is always a valid level.
    private val thinkingCombo = JComboBox(arrayOf("off", "low", "medium", "high"))
    private val workspacePathField = JTextField(28).apply {
        // Pre-filled with the open project's basePath and locked — users can't
        // create an agent for a different workspace from inside the IDE panel.
        // isEditable (not isEnabled) so the path stays at full-contrast text
        // (matches the other fields) but can't be typed into. Tooltip spells
        // out why it's locked.
        isEditable = false
        toolTipText = "Workspace path is locked to the currently open IDE project"
    }
    // System Prompt area: lineWrap + wrapStyleWord so long single-line text
    // doesn't push a horizontal scrollbar; no fixed preferredSize so the box
    // starts compact and only grows when content actually needs more space.
    private val systemPromptArea = JTextArea(5, 40).apply {
        lineWrap = true
        wrapStyleWord = true
    }
    private val appendSystemPromptArea = JTextArea(3, 40).apply {
        lineWrap = true
        wrapStyleWord = true
    }
    private val toolsField = JTextField(24)
    private val statusLabel = JLabel(" ", JLabel.LEFT)
    private lateinit var submitButton: JButton

    init {
        // Pre-populate from existing (Edit mode) or apply defaults (Create mode).
        if (existing != null) {
            nameField.text = existing.name
            descriptionArea.text = existing.description ?: ""
            workspacePathField.text = existing.workspacePath
            // Seed the combo's editor text so it shows the current model even
            // before the async /api/models fetch returns.
            modelCombo.editor.item = existing.model
            thinkingCombo.selectedItem = existing.thinkingLevel ?: "off"
            systemPromptArea.text = existing.systemPrompt
            appendSystemPromptArea.text = existing.appendSystemPrompt ?: ""
            toolsField.text = existing.tools?.joinToString(", ") ?: ""
        } else {
            workspacePathField.text = defaultWorkspacePath
        }

        val form = JPanel(GridBagLayout())
        val gbc = GridBagConstraints().apply {
            fill = GridBagConstraints.HORIZONTAL
            anchor = GridBagConstraints.WEST
            insets = Insets(4, 4, 4, 4)
        }
        var y = 0
        fun row(label: String, comp: JComponent, multiLine: Boolean = false) {
            gbc.gridx = 0; gbc.gridy = y; gbc.weightx = 0.0
            form.add(JLabel(label), gbc)
            gbc.gridx = 1; gbc.weightx = 1.0
            if (multiLine) {
                comp.preferredSize = Dimension(360, 80)
                comp.minimumSize = Dimension(200, 60)
            }
            form.add(comp, gbc)
            y++
        }
        row("Name *", nameField)
        row("Model *", modelCombo)
        row("Workspace Path *", workspacePathField)
        row("Thinking Level", thinkingCombo)
        // Wrap in JScrollPane for when content exceeds visible rows (multi-line),
        // but DON'T pin a fixed preferredSize — JScrollPane with VERTICAL_SCROLLBAR_AS_NEEDED
        // (the default) only shows the scrollbar when content actually overflows.
        // Without a forced height, short text shows no scrollbar at all.
        row("Description", JScrollPane(descriptionArea))
        row("System Prompt", JScrollPane(systemPromptArea))
        row("Append System Prompt", JScrollPane(appendSystemPromptArea))
        row("Tools (comma-separated)", toolsField)

        val cancelButton = JButton("Cancel").apply {
            addActionListener { dispose() }
        }
        submitButton = JButton(if (existing == null) "Create" else "Save").apply {
            addActionListener { onSubmitClicked() }
        }
        val buttons = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            add(statusLabel)
            add(Box.createHorizontalGlue())
            add(cancelButton)
            add(Box.createHorizontalStrut(8))
            add(submitButton)
        }

        val root = JPanel(BorderLayout()).apply {
            border = BorderFactory.createEmptyBorder(12, 12, 8, 12)
            add(form, BorderLayout.CENTER)
            add(buttons, BorderLayout.SOUTH)
        }
        contentPane = root
        defaultCloseOperation = DISPOSE_ON_CLOSE
        pack()
        // Cap width — long systemPrompt would otherwise balloon the dialog.
        val maxW = 720
        if (width > maxW) setSize(maxW, height)
        setLocationRelativeTo(owner)

        // Asynchronously fetch the model registry. If it succeeds, populate the
        // combo with concrete options. If it fails, the combo stays editable so
        // the user can type the model value themselves (graceful degradation).
        Thread {
            val models = client.listAvailableModels()
            SwingUtilities.invokeLater {
                if (models.isNotEmpty()) {
                    modelCombo.removeAllItems()
                    models.forEach { modelCombo.addItem(it) }
                    // After population, lock down editing — selection only.
                    modelCombo.isEditable = false
                    // If we're in Edit mode, select the existing model so it
                    // shows displayName (not raw `provider/modelId`).
                    if (existing != null) {
                        val match = models.firstOrNull { it.value == existing.model }
                        if (match != null) {
                            modelCombo.selectedItem = match
                        } else {
                            // Model not in registry anymore — fall back to editable
                            // and show the raw value so user can fix it.
                            modelCombo.isEditable = true
                            modelCombo.editor.item = existing.model
                        }
                    }
                    // Make the editor render displayName (not provider/modelId).
                    val renderer = javax.swing.DefaultListCellRenderer().apply {
                        horizontalAlignment = javax.swing.SwingConstants.LEFT
                    }
                    modelCombo.renderer = renderer
                } else {
                    statusLabel.text = "Model list unavailable — type 'provider/modelId' manually"
                }
            }
        }.start()
    }

    private fun onSubmitClicked() {
        val name = nameField.text.trim()
        // modelCombo can hold either a ModelOption (populated) or a String
        // (user typed manually when the registry fetch failed). Handle both.
        val model: String = when (val sel = modelCombo.editor.item) {
            is ServerApiClient.ModelOption -> sel.value
            is String -> sel.trim()
            else -> {
                val raw = modelCombo.selectedItem
                when (raw) {
                    is ServerApiClient.ModelOption -> raw.value
                    is String -> raw.trim()
                    else -> ""
                }
            }
        }
        val workspacePath = workspacePathField.text.trim()
        if (name.isEmpty()) { statusLabel.text = "Name is required"; return }
        if (model.isEmpty()) { statusLabel.text = "Model is required"; return }
        if (workspacePath.isEmpty()) { statusLabel.text = "Workspace Path is required"; return }
        if (!model.contains('/')) {
            statusLabel.text = "Model should be 'provider/modelId' (missing slash)"
            return
        }

        val thinkingLevel = (thinkingCombo.selectedItem as? String)?.takeIf { it.isNotEmpty() }
        val description = descriptionArea.text.trim().takeIf { it.isNotEmpty() }
        val systemPrompt = systemPromptArea.text
        val appendSystemPrompt = appendSystemPromptArea.text.trim().takeIf { it.isNotEmpty() }
        val tools = toolsField.text.split(',').map { it.trim() }.filter { it.isNotEmpty() }

        val payload = ServerApiClient.CreateAgentPayload(
            name = name,
            description = description,
            workspacePath = workspacePath,
            model = model,
            thinkingLevel = thinkingLevel,
            systemPrompt = systemPrompt,
            appendSystemPrompt = appendSystemPrompt,
            tools = tools,
        )

        val actionLabel = if (existing == null) "Creating" else "Saving"
        statusLabel.text = "$actionLabel..."
        submitButton.isEnabled = false
        Thread {
            try {
                val saved = if (existing == null) {
                    client.createAgent(payload)
                } else {
                    client.updateAgent(existing.id, payload)
                }
                SwingUtilities.invokeLater {
                    onSaved(saved)
                    dispose()
                }
            } catch (e: AgentApiException) {
                // Server told us WHY — surface the message verbatim.
                PluginLogger.warn("Agent ${if (existing == null) "create" else "update"} failed: ${e.message}")
                SwingUtilities.invokeLater {
                    statusLabel.text = e.message
                    submitButton.isEnabled = true
                }
            } catch (e: Exception) {
                PluginLogger.error("Agent ${if (existing == null) "create" else "update"} error: ${e.message}", e)
                SwingUtilities.invokeLater {
                    statusLabel.text = "${e.javaClass.simpleName}: ${e.message ?: "(no message)"}"
                    submitButton.isEnabled = true
                }
            }
        }.start()
    }
}