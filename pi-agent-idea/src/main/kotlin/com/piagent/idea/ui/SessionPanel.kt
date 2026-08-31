package com.piagent.idea.ui

import com.intellij.openapi.project.Project
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.piagent.idea.server.ServerApiClient
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Cursor
import java.awt.Dimension
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JLabel
import javax.swing.JMenuItem
import javax.swing.JOptionPane
import javax.swing.JPanel
import javax.swing.JPopupMenu
import javax.swing.JScrollPane
import javax.swing.SwingUtilities
import javax.swing.border.EmptyBorder

/**
 * Lists all sessions for agents matching the given workspace.
 * Each session = a card (title + agent · time). Click anywhere on the card → open.
 *
 * Bottom-right "关联 pi 会话" button registers an EXISTING pi session file
 * (e.g. one produced by `pi` TUI) into the sessions table without spawning a
 * worker. The user picks an agent → picks a `.jsonl` file on disk → server
 * reads the file header to extract sessionId, then snapshots the agent's config.
 */
class SessionPanel(
    private val client: ServerApiClient,
    private val project: Project,
    private val currentProjectPath: String,
    private val onOpenSession: (session: ServerApiClient.Session) -> Unit,
) : JPanel(BorderLayout()) {

    private val listContainer = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        border = EmptyBorder(8, 12, 8, 12)
    }

    private var rowSessions: List<ServerApiClient.Session> = emptyList()
    private var agentNames: Map<String, String> = emptyMap()

    init {
        val scroll = JScrollPane(listContainer)
        scroll.border = EmptyBorder(0, 0, 0, 0)
        add(scroll, BorderLayout.CENTER)
        add(buildImportButtonRow(), BorderLayout.SOUTH)
        reload()
    }

    /**
     * Bottom row with the "关联 pi 会话" button right-aligned.
     * On click: pick agent → pick .jsonl file → POST /api/sessions/import-from-file → reload.
     */
    private fun buildImportButtonRow(): JPanel {
        val row = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            border = EmptyBorder(6, 8, 6, 8)
        }
        row.add(Box.createHorizontalGlue())
        val button = JButton("关联 pi 会话").apply {
            // Slim look — sits at the corner without dominating the panel.
            isFocusable = false
            margin = java.awt.Insets(2, 8, 2, 8)
            font = font.deriveFont(java.awt.Font.PLAIN, 11f)
            toolTipText = "Register an existing pi session file (e.g. from `pi` TUI) into this workspace"
            addActionListener { onImportClicked() }
        }
        row.add(button)
        return row
    }

    private fun onImportClicked() {
        val agents = client.listAgents(currentProjectPath)
        if (agents.isEmpty()) {
            JOptionPane.showMessageDialog(
                this,
                "No agents exist for workspace:\n$currentProjectPath\nCreate an agent first.",
                "Cannot import pi session",
                JOptionPane.WARNING_MESSAGE,
            )
            return
        }
        // Pick agent by name (display) → look up the full record.
        val names = agents.map { it.name }.toTypedArray()
        val pickedName = JOptionPane.showInputDialog(
            this,
            "Select agent to associate this session with:",
            "Import pi session",
            JOptionPane.PLAIN_MESSAGE,
            null,
            names,
            names.first(),
        ) ?: return
        val agent = agents.first { it.name == pickedName }

        // File chooser — IntelliJ's native dialog (no platform <-> plugin file path surprises).
        // We don't pre-filter by extension because pi session files can be named
        // <timestamp>_<uuid>.jsonl (with the slash-cwd hash). Keep it open so users
        // can pick whatever they have.
        val descriptor = FileChooserDescriptorFactory.createSingleFileDescriptor()
            .withTitle("Select pi session file")
            .withDescription("Pick a .jsonl session file produced by `pi` (typically under ~/.pi/agent/sessions/)")
        val file = FileChooser.chooseFile(descriptor, project, null) ?: return

        Thread {
            val imported = client.importSessionFromFile(agent.id, file.path)
            SwingUtilities.invokeLater {
                if (imported == null) {
                    JOptionPane.showMessageDialog(
                        this,
                        "Import failed. See IDEA log for details.\nMake sure the file is a valid pi session JSONL (header line has type=\"session\").",
                        "Import pi session",
                        JOptionPane.ERROR_MESSAGE,
                    )
                } else {
                    reload()
                }
            }
        }.start()
    }

    fun reload() {
        listContainer.removeAll()
        // Server-side workspacePath filter (joins agents table on server).
        // Returns only sessions whose agent.workspacePath == currentProjectPath (exact, normalized).
        val matchingAgents = client.listAgents(currentProjectPath)
        agentNames = matchingAgents.associate { it.id to it.name }

        val sessions = client.listSessions(workspacePath = currentProjectPath)
        rowSessions = sessions.sortedByDescending { it.lastActiveAt }

        if (rowSessions.isEmpty()) {
            listContainer.add(emptyState())
        } else {
            rowSessions.forEach { session ->
                listContainer.add(sessionCard(session))
            }
        }
        listContainer.revalidate()
        listContainer.repaint()
    }

    private fun sessionCard(session: ServerApiClient.Session): JPanel {
        val titleText = session.title ?: "(无标题)"
        val agentText = agentNames[session.agentId] ?: session.agentId

        val card = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            border = EmptyBorder(4, 12, 4, 12)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            isOpaque = false
            alignmentX = JPanel.LEFT_ALIGNMENT
            maximumSize = Dimension(Int.MAX_VALUE, 40)

            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (SwingUtilities.isLeftMouseButton(e) && e.clickCount == 2) {
                        onOpenSession(session)
                    }
                }
                override fun mousePressed(e: MouseEvent) {
                    // Right-click → context menu (Remove + Open). Use mousePressed
                    // (not mouseClicked) so popup fires on Windows/Linux where
                    // isPopupTrigger is only set in pressed, not released.
                    if (e.isPopupTrigger) {
                        showSessionContextMenu(session, e)
                    }
                }
                override fun mouseReleased(e: MouseEvent) {
                    // macOS sets isPopupTrigger on release.
                    if (e.isPopupTrigger) {
                        showSessionContextMenu(session, e)
                    }
                }
                override fun mouseEntered(e: MouseEvent) {
                    background = Color(0x2a, 0x2a, 0x2a)
                    isOpaque = true
                    repaint()
                }
                override fun mouseExited(e: MouseEvent) {
                    isOpaque = false
                    background = null
                    repaint()
                }
            })
        }

        val left = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            alignmentX = JPanel.LEFT_ALIGNMENT
            isOpaque = false
        }
        left.add(JLabel(titleText).apply {
            font = font.deriveFont(java.awt.Font.PLAIN, 12f)
            foreground = Color(0xdd, 0xdd, 0xdd)
            alignmentX = JLabel.LEFT_ALIGNMENT
        })
        // Subtitle: "agent · model · thinking · time" — comma-separated for readability.
        val tlText = session.thinkingLevel ?: "—"
        val meta = listOf(
            agentText,
            session.model.ifBlank { "(no model)" },
            "thinking: $tlText",
            formatRelative(session.lastActiveAt),
        ).joinToString(" · ")
        left.add(JLabel(meta).apply {
            font = font.deriveFont(10f)
            foreground = Color(0x88, 0x88, 0x88)
            alignmentX = JLabel.LEFT_ALIGNMENT
        })
        card.add(left)
        card.add(Box.createHorizontalGlue())

        // Green dot when worker is online; nothing when offline (per user feedback).
        if (session.worker != null && session.worker.pid > 0) {
            card.add(JLabel(CircleIcon(Color(0x4c, 0xaf, 0x50), 8)).apply {
                border = EmptyBorder(0, 6, 0, 0)
            })
        }

        return card
    }

    /**
     * Right-click context menu on a session card: Open / Remove. Remove triggers
     * a confirm dialog (destructive — kills worker + unlinks the pi session
     * file on disk + drops the DB row).
     */
    private fun showSessionContextMenu(session: ServerApiClient.Session, e: MouseEvent) {
        val menu = JPopupMenu()
        menu.add(JMenuItem("Open").apply {
            addActionListener { onOpenSession(session) }
        })
        menu.add(JMenuItem("Remove").apply {
            addActionListener { confirmAndRemoveSession(session) }
        })
        menu.show(e.component, e.x, e.y)
    }

    private fun confirmAndRemoveSession(session: ServerApiClient.Session) {
        val title = session.title?.takeIf { it.isNotBlank() } ?: session.id.take(8)
        val confirm = JOptionPane.showConfirmDialog(
            this,
            "Remove session \"$title\"?\n\n" +
                "This will kill any active worker, delete the pi session file on disk, " +
                "and remove the session row from the database. This cannot be undone.",
            "Remove session",
            JOptionPane.OK_CANCEL_OPTION,
            JOptionPane.WARNING_MESSAGE,
        )
        if (confirm != JOptionPane.OK_OPTION) return
        Thread {
            val ok = client.deleteSession(session.id)
            SwingUtilities.invokeLater {
                if (!ok) {
                    JOptionPane.showMessageDialog(
                        this,
                        "Failed to remove session (see IDEA log for details).",
                        "Remove session",
                        JOptionPane.ERROR_MESSAGE,
                    )
                } else {
                    reload()
                }
            }
        }.start()
    }

    /** Minimal solid-filled circle icon used for the "worker online" indicator. */
    private class CircleIcon(private val color: Color, private val size: Int) : javax.swing.Icon {
        override fun paintIcon(c: java.awt.Component?, g: java.awt.Graphics, x: Int, y: Int) {
            val g2 = g as java.awt.Graphics2D
            g2.setRenderingHint(java.awt.RenderingHints.KEY_ANTIALIASING, java.awt.RenderingHints.VALUE_ANTIALIAS_ON)
            g2.color = color
            g2.fillOval(x + 1, y + 1, size - 2, size - 2)
        }
        override fun getIconWidth(): Int = size
        override fun getIconHeight(): Int = size
    }

    private fun emptyState(): JPanel {
        val panel = JPanel(GridBagLayout()).apply {
            border = EmptyBorder(60, 40, 60, 40)
        }
        val gbc = GridBagConstraints().apply {
            anchor = GridBagConstraints.CENTER
        }
        panel.add(JLabel("暂无历史会话").apply {
            font = font.deriveFont(java.awt.Font.PLAIN, 14f)
            foreground = Color(0x88, 0x88, 0x88)
        }, gbc)
        return panel
    }

    private fun formatRelative(ts: Long): String {
        val diff = System.currentTimeMillis() - ts
        return when {
            diff < 60_000 -> "刚刚"
            diff < 3_600_000 -> "${diff / 60_000} 分钟前"
            diff < 86_400_000 -> "${diff / 3_600_000} 小时前"
            else -> "${diff / 86_400_000} 天前"
        }
    }
}