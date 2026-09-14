package com.piagent.idea.ui

import com.piagent.idea.PluginLogger
import com.piagent.idea.server.AgentApiException
import com.piagent.idea.server.ServerApiClient
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Frame
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JDialog
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTextArea
import javax.swing.JTextField
import javax.swing.SwingUtilities
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory

/**
 * Modal dialog for creating OR editing an Agent from inside the IDE plugin.
 *
 * Field set mirrors the web AgentsListView modal:
 *   - name (required)
 *   - model (required; dropdown from /api/models)
 *   - description (optional)
 *   - workspacePath (required; editable with folder chooser)
 *   - thinkingLevel (default off)
 *   - systemPrompt (optional)
 *   - appendSystemPrompt (optional)
 *   - builtinTools (checkbox list: null=all, []=none, [names]=selected)
 *   - extensions (checkbox list; fetched from /api/config/extensions)
 *   - skills (checkbox list; fetched from /api/config/skills)
 *   - prompts (checkbox list; fetched from /api/config/prompts)
 */
class AddAgentDialog(
    owner: Frame,
    private val client: ServerApiClient,
    private val defaultWorkspacePath: String,
    private val existing: ServerApiClient.Agent? = null,
    private val onSaved: (ServerApiClient.Agent) -> Unit,
) : JDialog(owner, if (existing == null) "Add Agent" else "Edit Agent", true) {

    companion object {
        private val BUILTIN_TOOLS = listOf("read", "write", "edit", "bash", "grep", "find", "ls")
    }

    private val nameField = JTextField(24)
    private val modelCombo = JComboBox<ServerApiClient.ModelOption>().apply {
        isEditable = true
        preferredSize = Dimension(360, 28)
    }
    private val descriptionArea = JTextArea(3, 24)
    private val thinkingCombo = JComboBox(arrayOf("off", "low", "medium", "high"))
    private val workspacePathField = JTextField(28)
    private val systemPromptArea = JTextArea(5, 40).apply { lineWrap = true; wrapStyleWord = true }
    private val appendSystemPromptArea = JTextArea(3, 40).apply { lineWrap = true; wrapStyleWord = true }

    // Config checkbox state: null = use default (all), empty list = none, non-empty = selected
    private var builtinToolsSelection: List<String>? = null
    private var extensionsSelection: List<String>? = null
    private var skillsSelection: List<String>? = null
    private var promptsSelection: List<String>? = null

    // Checkbox panels (rebuilt when fetched)
    private lateinit var builtinToolsPanel: JPanel
    private lateinit var extensionsPanel: JPanel
    private lateinit var skillsPanel: JPanel
    private lateinit var promptsPanel: JPanel

    private val statusLabel = JLabel(" ", JLabel.LEFT)
    private lateinit var submitButton: JButton

    init {
        // Pre-populate from existing (Edit mode) or apply defaults (Create mode).
        if (existing != null) {
            nameField.text = existing.name
            descriptionArea.text = existing.description ?: ""
            workspacePathField.text = existing.workspacePath
            modelCombo.editor.item = existing.model
            thinkingCombo.selectedItem = existing.thinkingLevel ?: "off"
            systemPromptArea.text = existing.config?.systemPrompt ?: ""
            appendSystemPromptArea.text = existing.config?.appendSystemPrompt ?: ""
            builtinToolsSelection = existing.config?.builtinTools
            extensionsSelection = existing.config?.extensions
            skillsSelection = existing.config?.skills
            promptsSelection = existing.config?.prompts
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
        fun rowFull(label: String, comp: JComponent) {
            gbc.gridx = 0; gbc.gridy = y; gbc.gridwidth = 2; gbc.weightx = 1.0
            form.add(comp, gbc)
            gbc.gridwidth = 1
            y++
        }

        row("Name *", nameField)
        row("Model *", modelCombo)
        row("Workspace Path *", buildWorkspacePathRow())
        row("Thinking Level", thinkingCombo)
        row("Description", JScrollPane(descriptionArea))
        row("System Prompt", JScrollPane(systemPromptArea))
        row("Append System Prompt", JScrollPane(appendSystemPromptArea))

        // Config sections — initialized with placeholder, rebuilt async
        builtinToolsPanel = buildCheckboxSection("Builtin Tools", BUILTIN_TOOLS, builtinToolsSelection) { builtinToolsSelection = it }
        extensionsPanel = buildPlaceholderSection("Extensions")
        skillsPanel = buildPlaceholderSection("Skills")
        promptsPanel = buildPlaceholderSection("Prompts")

        rowFull("Builtin Tools", builtinToolsPanel)
        rowFull("Extensions", extensionsPanel)
        rowFull("Skills", skillsPanel)
        rowFull("Prompts", promptsPanel)

        val cancelButton = JButton("Cancel").apply { addActionListener { dispose() } }
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

        val scrollPane = JScrollPane(form).apply {
            border = null
            verticalScrollBarPolicy = JScrollPane.VERTICAL_SCROLLBAR_AS_NEEDED
            horizontalScrollBarPolicy = JScrollPane.HORIZONTAL_SCROLLBAR_NEVER
        }
        val root = JPanel(BorderLayout()).apply {
            border = BorderFactory.createEmptyBorder(12, 12, 8, 12)
            add(scrollPane, BorderLayout.CENTER)
            add(buttons, BorderLayout.SOUTH)
        }
        contentPane = root
        defaultCloseOperation = DISPOSE_ON_CLOSE
        isResizable = true
        // Fixed size — form scrolls inside; config sections loaded async will fit
        setSize(720, 600)
        minimumSize = Dimension(560, 400)
        setLocationRelativeTo(owner)

        // Async fetch: models + skills + prompts + extensions
        Thread {
            val models = client.listAvailableModels()
            val skills = client.listSkills()
            val prompts = client.listPrompts()
            val extensions = client.listExtensions()
            SwingUtilities.invokeLater {
                // Models
                if (models.isNotEmpty()) {
                    modelCombo.removeAllItems()
                    models.forEach { modelCombo.addItem(it) }
                    modelCombo.isEditable = false
                    if (existing != null) {
                        val match = models.firstOrNull { it.value == existing.model }
                        if (match != null) {
                            modelCombo.selectedItem = match
                        } else {
                            modelCombo.isEditable = true
                            modelCombo.editor.item = existing.model
                        }
                    }
                    modelCombo.renderer = javax.swing.DefaultListCellRenderer().apply {
                        horizontalAlignment = javax.swing.SwingConstants.LEFT
                    }
                } else {
                    statusLabel.text = "Model list unavailable — type 'provider/modelId' manually"
                }
                // Extensions
                rebuildCheckboxSection(extensionsPanel, "Extensions", extensions, extensionsSelection) { extensionsSelection = it }
                // Skills
                rebuildCheckboxSection(skillsPanel, "Skills", skills.map { it.name }, skillsSelection) { skillsSelection = it }
                // Prompts
                rebuildCheckboxSection(promptsPanel, "Prompts", prompts.map { it.name }, promptsSelection) { promptsSelection = it }

                // Trigger scroll pane to recalculate after config sections are populated
                scrollPane.viewport.revalidate()
            }
        }.start()
    }

    private fun buildWorkspacePathRow(): JPanel {
        val panel = JPanel(BorderLayout(4, 0))
        panel.add(workspacePathField, BorderLayout.CENTER)
        val browseBtn = JButton("…").apply {
            toolTipText = "Choose workspace folder"
            preferredSize = Dimension(32, workspacePathField.preferredSize.height)
            addActionListener { browseFolder() }
        }
        panel.add(browseBtn, BorderLayout.EAST)
        return panel
    }

    private fun browseFolder() {
        val descriptor = FileChooserDescriptorFactory.createSingleFolderDescriptor()
            .withTitle("Select Workspace")
            .withDescription("Choose the agent's working directory")
        val currentPath = workspacePathField.text.trim()
        val files = FileChooser.chooseFiles(descriptor, null, null)
        if (files.isNotEmpty()) {
            workspacePathField.text = files[0].path
        }
    }

    /**
     * Build a checkbox config section with "Use default" toggle + Select All / Clear All.
     * [initialSelection]: null = use default, empty = none, non-empty = selected names.
     */
    private fun buildCheckboxSection(
        title: String,
        allItems: List<String>,
        initialSelection: List<String>?,
        onSelectionChange: (List<String>?) -> Unit,
    ): JPanel {
        val panel = JPanel()
        panel.layout = BoxLayout(panel, BoxLayout.Y_AXIS)
        panel.border = BorderFactory.createCompoundBorder(
            BorderFactory.createLineBorder(javax.swing.UIManager.getColor("Separator.foreground") ?: java.awt.Color(0xCCCCCC)),
            BorderFactory.createEmptyBorder(6, 8, 6, 8),
        )

        val defaultCheckBox = JCheckBox("Use default (all enabled)", initialSelection == null)
        panel.add(defaultCheckBox)

        val optionsPanel = JPanel()
        optionsPanel.layout = BoxLayout(optionsPanel, BoxLayout.Y_AXIS)
        optionsPanel.isVisible = initialSelection != null

        // Select All / Clear All row
        val actionsRow = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0))
        val selectAllBtn = JButton("Select All").apply {
            isBorderPainted = false
            isContentAreaFilled = false
            foreground = javax.swing.UIManager.getColor("Link.foreground") ?: java.awt.Color(0x3577E9)
            addActionListener {
                val checkboxes = optionsPanel.components.filterIsInstance<JCheckBox>()
                checkboxes.forEach { it.isSelected = true }
                onSelectionChange(allItems)
            }
        }
        val clearAllBtn = JButton("Clear All").apply {
            isBorderPainted = false
            isContentAreaFilled = false
            foreground = javax.swing.UIManager.getColor("Link.foreground") ?: java.awt.Color(0x3577E9)
            addActionListener {
                val checkboxes = optionsPanel.components.filterIsInstance<JCheckBox>()
                checkboxes.forEach { it.isSelected = false }
                onSelectionChange(emptyList())
            }
        }
        actionsRow.add(selectAllBtn)
        actionsRow.add(clearAllBtn)
        optionsPanel.add(actionsRow)

        // Checkboxes
        val selectedSet = initialSelection?.toSet() ?: emptySet()
        for (item in allItems) {
            val cb = JCheckBox(item, selectedSet.contains(item))
            cb.addActionListener {
                val checked = optionsPanel.components.filterIsInstance<JCheckBox>().filter { it.isSelected }.map { it.text }
                onSelectionChange(checked)
            }
            optionsPanel.add(cb)
        }
        if (allItems.isEmpty()) {
            optionsPanel.add(JLabel("(none available)").apply {
                foreground = javax.swing.UIManager.getColor("ComponentInfo.foreground") ?: java.awt.Color(0x888888)
            })
        }

        defaultCheckBox.addActionListener {
            optionsPanel.isVisible = !defaultCheckBox.isSelected
            onSelectionChange(if (defaultCheckBox.isSelected) null else emptyList())
            // Re-layout
            SwingUtilities.getWindowAncestor(panel)?.pack()
        }

        panel.add(optionsPanel)
        return panel
    }

    private fun buildPlaceholderSection(title: String): JPanel {
        val panel = JPanel(BorderLayout())
        panel.border = BorderFactory.createCompoundBorder(
            BorderFactory.createLineBorder(javax.swing.UIManager.getColor("Separator.foreground") ?: java.awt.Color(0xCCCCCC)),
            BorderFactory.createEmptyBorder(6, 8, 6, 8),
        )
        panel.add(JLabel("Loading $title…").apply {
            foreground = javax.swing.UIManager.getColor("ComponentInfo.foreground") ?: java.awt.Color(0x888888)
        }, BorderLayout.CENTER)
        return panel
    }

    private fun rebuildCheckboxSection(
        panel: JPanel,
        title: String,
        items: List<String>,
        currentSelection: List<String>?,
        onSelectionChange: (List<String>?) -> Unit,
    ) {
        panel.removeAll()
        panel.layout = BoxLayout(panel, BoxLayout.Y_AXIS)
        val newPanel = buildCheckboxSection(title, items, currentSelection, onSelectionChange)
        // Copy children from the rebuilt panel
        for (comp in newPanel.components) {
            panel.add(comp)
        }
        panel.revalidate()
        panel.repaint()
    }

    private fun onSubmitClicked() {
        val name = nameField.text.trim()
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

        val payload = ServerApiClient.CreateAgentPayload(
            name = name,
            description = description,
            workspacePath = workspacePath,
            model = model,
            thinkingLevel = thinkingLevel,
            config = ServerApiClient.AgentConfig(
                systemPrompt = systemPrompt.ifBlank { null },
                appendSystemPrompt = appendSystemPrompt,
                builtinTools = builtinToolsSelection,
                extensions = extensionsSelection,
                skills = skillsSelection,
                prompts = promptsSelection,
            ),
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
