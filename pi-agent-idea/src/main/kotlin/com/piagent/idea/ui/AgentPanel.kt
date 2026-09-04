package com.piagent.idea.ui

import com.intellij.openapi.project.Project
import com.piagent.idea.server.ServerApiClient
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Cursor
import java.awt.Dimension
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.SwingUtilities
import com.intellij.ui.JBColor

/**
 * Lists agents whose workspacePath matches the given project path.
 * Each row has a [新会话] button → callback.onNewSession(agentId).
 * Below the list, an "Add Agent" row (+ icon) invokes [onAddAgent] so the
 * parent (ChatToolWindowFactory) can pop the AddAgentDialog modal with the
 * project's basePath pre-filled.
 */
class AgentPanel(
    private val client: ServerApiClient,
    val project: Project,
    private val currentProjectPath: String,
    private val onNewSession: (agentId: String) -> Unit,
    private val onEditAgent: (ServerApiClient.Agent) -> Unit,
    private val onRemoveAgent: (ServerApiClient.Agent) -> Unit,
    private val onAddAgent: () -> Unit,
) : JPanel(BorderLayout()) {

    private val listContainer = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
    }

    init {
        val scroll = JScrollPane(listContainer)
        add(scroll, BorderLayout.CENTER)
        reload()
    }

    fun reload() {
        listContainer.removeAll()
        val agents = client.listAgents(currentProjectPath)
        agents.forEach { agent ->
            listContainer.add(agentRow(agent))
            listContainer.add(Box.createVerticalStrut(6))
        }
        // "Add Agent" row at the bottom — always present so users can grow the
        // list without leaving the panel. When no agents exist this becomes the
        // only content (no empty-state placeholder crowding it down).
        listContainer.add(Box.createVerticalStrut(6))
        listContainer.add(addAgentRow())
        listContainer.revalidate()
        listContainer.repaint()
    }

    private fun addAgentRow(): JPanel {
        val hoverBg = JBColor(0xE8E8E8, 0x333333)
        val row = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            border = javax.swing.border.EmptyBorder(6, 12, 6, 12)
            alignmentX = JPanel.LEFT_ALIGNMENT
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            addMouseListener(object : java.awt.event.MouseAdapter() {
                override fun mouseClicked(e: java.awt.event.MouseEvent) {
                    if (SwingUtilities.isLeftMouseButton(e) && e.clickCount == 1) {
                        onAddAgent()
                    }
                }
                override fun mouseEntered(e: java.awt.event.MouseEvent) {
                    background = hoverBg
                    isOpaque = true
                }
                override fun mouseExited(e: java.awt.event.MouseEvent) {
                    isOpaque = false
                    background = null
                }
            })
        }
        val plus = JLabel("+").apply {
            font = font.deriveFont(java.awt.Font.BOLD, 16f)
            foreground = JBColor(0x666666, 0xAAAAAA)
            border = javax.swing.border.EmptyBorder(0, 0, 0, 8)
        }
        val label = JLabel("Add Agent").apply {
            font = font.deriveFont(java.awt.Font.PLAIN, 12f)
            foreground = JBColor(0x666666, 0xAAAAAA)
        }
        row.add(plus)
        row.add(label)
        row.add(Box.createHorizontalGlue())
        row.maximumSize = Dimension(Int.MAX_VALUE, 32)
        return row
    }

    private fun agentRow(agent: ServerApiClient.Agent): JPanel {
        val row = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            border = javax.swing.border.EmptyBorder(4, 12, 4, 12)
            alignmentX = JPanel.LEFT_ALIGNMENT
        }

        val left = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = JPanel.LEFT_ALIGNMENT
            isOpaque = false
        }
        left.add(JLabel(agent.name).apply {
            font = font.deriveFont(java.awt.Font.BOLD, 12f)
            alignmentX = JLabel.LEFT_ALIGNMENT
        })
        left.add(JLabel(agent.model).apply {
            font = font.deriveFont(10f)
            foreground = JBColor(0x888888, 0x888888)
            alignmentX = JLabel.LEFT_ALIGNMENT
        })
        row.add(left)

        row.add(Box.createHorizontalGlue())

        val newSessionButton = JButton("New").apply {
            addActionListener { onNewSession(agent.id) }
            maximumSize = java.awt.Dimension(80, 28)
            preferredSize = java.awt.Dimension(60, 24)
        }
        row.add(newSessionButton)
        row.add(Box.createHorizontalStrut(4))
        val editButton = JButton("Edit").apply {
            toolTipText = "Edit agent config"
            addActionListener { onEditAgent(agent) }
            maximumSize = java.awt.Dimension(80, 28)
            preferredSize = java.awt.Dimension(60, 24)
        }
        row.add(editButton)
        row.add(Box.createHorizontalStrut(4))
        val removeButton = JButton("Remove").apply {
            toolTipText = "Remove this agent and all its sessions (cascades to pi session files on disk)"
            addActionListener { onRemoveAgent(agent) }
            maximumSize = java.awt.Dimension(80, 28)
            preferredSize = java.awt.Dimension(60, 24)
        }
        row.add(removeButton)

        row.maximumSize = java.awt.Dimension(Int.MAX_VALUE, 40)
        return row
    }
}