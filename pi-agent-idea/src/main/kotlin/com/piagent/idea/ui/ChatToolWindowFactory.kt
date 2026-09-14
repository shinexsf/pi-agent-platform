package com.piagent.idea.ui

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import com.piagent.idea.PluginLogger
import com.piagent.idea.settings.PluginSettings
import com.piagent.idea.bridge.IdeaIdeBridge
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Cursor
import java.awt.Dimension
import java.awt.Font
import java.awt.Frame
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.event.ActionEvent
import java.awt.event.ActionListener
import java.awt.event.FocusAdapter
import java.awt.event.FocusEvent
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.BoxLayout
import javax.swing.Icon
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JMenuItem
import javax.swing.JPanel
import javax.swing.JPopupMenu
import javax.swing.JScrollPane
import javax.swing.JSeparator
import javax.swing.JTextField
import javax.swing.SwingConstants
import javax.swing.SwingUtilities
import javax.swing.border.EmptyBorder
import javax.swing.plaf.basic.BasicScrollBarUI
import com.intellij.ide.ui.LafManagerListener
import com.intellij.ui.JBColor
import com.intellij.openapi.application.ApplicationManager
import com.intellij.util.messages.MessageBusConnection

/**
 * 主 ToolWindow 入口。
 *
 * ⚠️ **PER-PROJECT STATE 隔离**：
 * `ToolWindowFactory` 是 **JVM 单例**（一个 class 一个 instance），但 IDEA 同进程
 * 可以挂多个 project，每个 project 有自己的 ToolWindow。如果把所有可变 UI 状态
 * 放在 factory 字段里，多 project 之间会互相覆盖——一个 project 点 Add Agent
 * 弹到另一个 project 的窗口就是经典例子。
 *
 * 修法：所有 project-bound 可变状态都装在 [WindowState] 里，factory 持
 * `Map<Project, WindowState>` 隔离。每个方法签名都接 `state: WindowState` 参数
 * （不接的话仍然会落到错误的 project 上）。
 *
 * Factory 字段（与 project 无关）：
 *   - settings: PluginSettings（应用单例）
 *   - connectionStatusAction: 标题栏状态指示（所有 project 共享同一个 server 连接状态）
 *   - 各种颜色/尺寸常量（JBColor 亮/暗自动切换）
 *
 * 布局：
 *   - 自实现 tab bar：chat tabs (CENTER) | fixed icon buttons (EAST, 固定贴右：Agents / Sessions)
 *   - body：active tab 内容（Agents / Sessions Swing panel 或 chat JCEF）
 *
 * 跟旧插件对比：
 *   - 旧插件 chat tab 内嵌 AiAssistantChatPanel（自管 RPC + 流式事件）
 *   - 新版 chat tab 内嵌 JcefChatPanel（JCEF 加载 server URL），消息流走 SSE 由 Vue 处理
 *   - 旧插件 onNewSessionFromAgent 要 spawn pi 子进程 + discoverer 拿 sessionId
 *   - 新版直接调 ServerApiClient.createPlaceholderSession(agentId) 拿 placeholder sessionId
 *     （第一条消息触发 server 真创建 row，跟 web 端一致 —— decision D3）
 *
 * Tab bar 高度 / 颜色约定：
 *   - 高度 = `tabBarHeight`（紧凑；约 = 一行字号 + 4px）
 *   - bg = JBColor(亮/暗)（跟随 IDE 主题）
 *   - hover = bg 稍亮一档（给点击反馈）
 *   - active 区别：仅底部 2px 蓝色边框 + icon 染色（不靠 bg 拉亮，避免"太亮"）
 *   - chat tab × 按钮：BorderLayout 内部 closeBtn 在 EAST、titleLabel 在 CENTER + maxWidth
 *     限定（修 "× 按钮位置不稳" bug —— 之前 BoxLayout 平铺，title 长会把 × 挤出）
 *
 * 主题跟随：
 *   - Tab bar 颜色用 JBColor（亮/暗随主题自动切换）
 *   - SessionPanel / AgentPanel 硬编码 Color 改为 JBColor
 *   - LafManagerListener 切主题时触发所有面板 repaint
 */
class ChatToolWindowFactory : ToolWindowFactory {

    private lateinit var settings: PluginSettings
    private val connectionStatusAction = ConnectionStatusAction()
    private var themeConnection: MessageBusConnection? = null

    /** Per-project state. Keyed by Project so two opened projects keep independent UI state. */
    private val windowStates = mutableMapOf<Project, WindowState>()

    /**
     * All mutable UI state for a single project's ToolWindow.
     * Construction goes through [ChatToolWindowFactory.createToolWindowContent].
     * Never share a WindowState across projects.
     */
    private inner class WindowState(val project: Project) {
        var activeTabId: String = "agents"
        var newChatCounter: Int = 0
        val chatSessions = mutableMapOf<String, JcefChatPanel>()
        val chatTabPanels = mutableMapOf<String, JPanel>()
        val fixedTabButtons = mutableMapOf<String, JButton>()
        val sessionTabManager = SessionTabManager()

        val tabBar: JPanel = JPanel(BorderLayout()).apply {
            preferredSize = Dimension(0, tabBarHeight)
            minimumSize = Dimension(0, tabBarHeight)
        }
        val chatTabsPanel: JPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            isOpaque = false
        }
        val chatTabsScrollPane: JScrollPane = JScrollPane(chatTabsPanel).apply {
            horizontalScrollBarPolicy = JScrollPane.HORIZONTAL_SCROLLBAR_AS_NEEDED
            verticalScrollBarPolicy = JScrollPane.VERTICAL_SCROLLBAR_NEVER
            border = null
            isOpaque = false
            viewport.isOpaque = false
            horizontalScrollBar.unitIncrement = 40
            horizontalScrollBar.blockIncrement = 120
            // Thin scrollbar + no arrow buttons for a compact tab bar look
            horizontalScrollBar.preferredSize = Dimension(0, 6)
            horizontalScrollBarUI = object : BasicScrollBarUI() {
                override fun configureScrollBarColors() {
                    thumbColor = JBColor(0xBBBBBB, 0x555555)
                    trackColor = JBColor(0xF0F0F0, 0x2B2B2B)
                }
                override fun createDecreaseButton(orientation: Int) = zeroBtn()
                override fun createIncreaseButton(orientation: Int) = zeroBtn()
                private fun zeroBtn() = JButton().apply {
                    preferredSize = Dimension(0, 0)
                    minimumSize = Dimension(0, 0)
                    maximumSize = Dimension(0, 0)
                }
            }
            // Shift + mouse wheel → horizontal scroll
            addMouseWheelListener { e ->
                if (e.isShiftDown) {
                    val sb = horizontalScrollBar
                    val delta = if (e.wheelRotation < 0) sb.unitIncrement else -sb.unitIncrement
                    sb.value = sb.value + delta
                    e.consume()
                }
            }
        }
        val fixedTabsPanel: JPanel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            isOpaque = false
        }
        val body: JPanel = JPanel(BorderLayout()).apply { isOpaque = false }
        val agentPanel: AgentPanel
        val sessionPanel: SessionPanel

        init {
            tabBar.add(chatTabsScrollPane, BorderLayout.CENTER)
            tabBar.add(fixedTabsPanel, BorderLayout.EAST)
            addFixedTabs(this)
            revalidateTabBar(this)

            val client = com.piagent.idea.server.ServerApiClient(settings.serverOrigin())
            val projectPath = project.basePath ?: ""
            agentPanel = AgentPanel(
                client,
                project,
                projectPath,
                // Lambdas below intentionally reference `this@WindowState` so
                // callbacks (fired later from Swing event dispatch) route to
                // THIS project's state — NOT to a stale factory field that
                // might now point at a different project.
                onNewSession = { agentId -> onNewSessionFromAgent(this@WindowState, agentId) },
                onEditAgent = { agent -> showAgentDialog(this@WindowState, agent) },
                onRemoveAgent = { agent -> confirmAndRemoveAgent(this@WindowState, agent) },
                onAddAgent = { showAgentDialog(this@WindowState, null) },
            )
            sessionPanel = SessionPanel(client, project, projectPath) { session ->
                onOpenSession(this@WindowState, session)
            }
            body.add(agentPanel, BorderLayout.CENTER)
            activeTabId = "agents"
            refreshTabActiveVisual(this)
        }
    }

    private fun stateFor(project: Project): WindowState =
        windowStates.getOrPut(project) { WindowState(project) }

    private val tabBarHeight = 22
    // JBColor(light, dark) — 每次 paint 时读，跟随 IDE 主题自动切换
    private val tabBgColor = JBColor(0xF5F5F5, 0x3C3F41)
    private val tabHoverBgColor = JBColor(0xE8E8E8, 0x4A4E51)
    private val tabSeparatorColor = JBColor(0xD0D0D0, 0x333537)
    private val tabActiveBorderColor = JBColor(0x3577E9, 0x3577E9)
    private val tabActiveBorderHeight = 2
    private val tabCloseBtnColor = JBColor(0x666666, 0xAAAAAA)
    private val tabCloseBtnHoverColor = JBColor(0xCC3333, 0xEE5555)
    private val tabTitleColor = JBColor(0x333333, 0xDDDDDD)
    private val tabErrorColor = JBColor(0xCC5555, 0xCC5555)

    private class ConnectionStatusAction : AnAction(), DumbAware {
        var status: Status = Status.Checking

        enum class Status { Checking, Connected, Failed }

        override fun actionPerformed(e: AnActionEvent) {
            // Status actions are read-only indicators
        }

        override fun update(e: AnActionEvent) {
            // Read serverUrl fresh on every update so settings changes show up
            // immediately without restarting IDEA (previously cached at
            // createToolWindowContent time).
            val serverUrl = PluginSettings.getInstance().serverUrl
            e.presentation.icon = when (status) {
                Status.Checking -> GrayDotIcon
                Status.Connected -> GreenDotIcon
                Status.Failed -> RedDotIcon
            }
            val state = when (status) {
                Status.Checking -> "checking…"
                Status.Connected -> "connected"
                Status.Failed -> "unreachable"
            }
            val tip = if (serverUrl.isBlank()) state else "$serverUrl\n$state"
            e.presentation.description = tip
            e.presentation.text = tip
            e.presentation.putClientProperty("tooltipText", tip)
        }
    }

    private object GrayDotIcon : Icon {
        private val c = JBColor(0x888888, 0x888888)
        override fun paintIcon(component: Component?, g: Graphics, x: Int, y: Int) {
            g.color = c; g.fillOval(x + 2, y + 2, 4, 4)
        }
        override fun getIconWidth() = 8; override fun getIconHeight() = 8
    }

    private object GreenDotIcon : Icon {
        private val c = JBColor(0x4CAF50, 0x66BB6A)
        override fun paintIcon(component: Component?, g: Graphics, x: Int, y: Int) {
            g.color = c; g.fillOval(x + 2, y + 2, 4, 4)
        }
        override fun getIconWidth() = 8; override fun getIconHeight() = 8
    }

    private object RedDotIcon : Icon {
        private val c = JBColor(0xCC5555, 0xCC5555)
        override fun paintIcon(component: Component?, g: Graphics, x: Int, y: Int) {
            g.color = c; g.fillOval(x + 2, y + 2, 4, 4)
        }
        override fun getIconWidth() = 8; override fun getIconHeight() = 8
    }

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        // settings is an application-level service; only init once.
        if (!::settings.isInitialized) {
            settings = PluginSettings.getInstance()
        }
        // Title + titleActions are ToolWindow-level (not project-level state),
        // but harmless to set per createToolWindowContent call.
        toolWindow.setTitle("Pi")
        toolWindow.setTitleActions(listOf(connectionStatusAction))

        if (!settings.isConfigured()) {
            connectionStatusAction.status = ConnectionStatusAction.Status.Failed
            renderUnconfigured(toolWindow)
            return
        }

        // Build (or reuse) THIS project's WindowState and mount its widget tree.
        val state = stateFor(project)
        mountToolWindow(toolWindow, state)
        checkConnection()

        // 订阅主题切换（LafManagerListener）：切主题时所有子面板 repaint
        if (themeConnection == null) {
            themeConnection = ApplicationManager.getApplication().messageBus.connect()
            themeConnection!!.subscribe(
                LafManagerListener.TOPIC,
                LafManagerListener {
                    // JBColor 自动返回新主题色，只需触发 repaint 让所有组件重绘
                    windowStates.values.forEach { ws ->
                        SwingUtilities.invokeLater {
                            ws.tabBar.repaint()
                            ws.body.repaint()
                            ws.agentPanel.repaint()
                            ws.sessionPanel.repaint()
                            ws.chatTabPanels.values.forEach { it.repaint() }
                        }
                    }
                }
            )
            PluginLogger.info("ChatToolWindowFactory: theme listener subscribed")
        }
    }

    private fun mountToolWindow(toolWindow: ToolWindow, state: WindowState) {
        val root = JPanel(BorderLayout()).apply {
            isOpaque = false
            add(state.tabBar, BorderLayout.NORTH)
            add(state.body, BorderLayout.CENTER)
        }
        toolWindow.contentManager.addContent(
            ContentFactory.getInstance().createContent(root, "", false)
        )
    }

    private fun renderUnconfigured(toolWindow: ToolWindow) {
        val panel = JPanel(BorderLayout())
        val label = JLabel("未配置 Server URL，请到 Settings → Tools → Pi 配置")
        panel.add(label, BorderLayout.CENTER)
        toolWindow.contentManager.addContent(
            ContentFactory.getInstance().createContent(panel, "", false)
        )
    }

    private fun checkConnection() {
        Thread {
            val ok = try {
                com.piagent.idea.server.ServerApiClient(settings.serverOrigin()).healthCheck()
            } catch (_: Exception) { false }
            SwingUtilities.invokeLater {
                connectionStatusAction.status = if (ok) {
                    ConnectionStatusAction.Status.Connected
                } else {
                    ConnectionStatusAction.Status.Failed
                }
            }
        }.start()
    }

    /**
     * Add an icon-only fixed tab (Agents / Sessions). Pinned right, no text,
     * selected-state shown via bottom blue border only (to keep the strip dim).
     */
    private fun addFixedTab(state: WindowState, tabIcon: Icon, tooltip: String, tabId: String) {
        // Only the active tab shows bg + bottom blue border. Inactive (incl. hover)
        // stays transparent — the icons stand on their own and the strip stays
        // visually quiet when a chat tab is in focus.
        val btn = object : JButton() {
            override fun paintComponent(g: Graphics) {
                val g2 = g.create() as? Graphics2D ?: return
                val isActive = getClientProperty("tabActive") as? Boolean == true
                if (isActive) {
                    g2.color = tabBgColor
                    g2.fillRect(0, 0, width, height)
                    g2.color = tabActiveBorderColor
                    g2.fillRect(0, height - tabActiveBorderHeight, width, tabActiveBorderHeight)
                }
                g2.dispose()
                super.paintComponent(g)
            }
        }.apply {
            isFocusable = false
            isBorderPainted = false
            isContentAreaFilled = false
            border = EmptyBorder(0, 6, 0, 6)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            margin = java.awt.Insets(0, 0, 0, 0)
            icon = tabIcon
            toolTipText = tooltip
            preferredSize = Dimension(28, tabBarHeight)
            maximumSize = Dimension(28, tabBarHeight)
            putClientProperty("tabActive", false)
            addActionListener { activateTab(state, tabId) }
            addMouseListener(tabHoverListener(this))
        }
        state.fixedTabButtons[tabId] = btn
        state.fixedTabsPanel.add(btn)
    }

    private fun addFixedTabs(state: WindowState) {
        // Placeholder icons; swap to custom SVG later if user wants.
        // AllIcons.General.User ≈ a person glyph (agents), AllIcons.Vcs.History ≈ list+clock (sessions).
        addFixedTab(state, AllIcons.General.User, "Agents", "agents")
        addSeparator(state.fixedTabsPanel)
        addFixedTab(state, AllIcons.Vcs.History, "Sessions", "sessions")
    }

    private fun addChatTab(state: WindowState, serverSessionId: String, title: String?) {
        // Per A3: prefer session.title; fall back to "New Chat #N" (auto-incrementing).
        val displayTitle = title?.takeIf { it.isNotBlank() }
            ?: "New Chat #${++state.newChatCounter}"
        val titleLabel = JLabel(displayTitle).apply {
            font = font.deriveFont(Font.PLAIN, 12f)
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            toolTipText = displayTitle
            border = EmptyBorder(2, 8, 2, 4)
            // Cap width so long titles can't push the × button out (bugfix):
            // BorderLayout.EAST is preferredSize-anchored, but if the inner panel
            // is BoxLayout(X_AXIS), both children compete for space and the close
            // button can get shoved off. Now using BorderLayout center with a max
            // width on the title label — close button always sticks to the right.
            maximumSize = Dimension(160, preferredSize.height)
        }
        // × close button (per A1)
        val closeBtn = JLabel("×").apply {
            font = font.deriveFont(Font.BOLD, 14f)
            foreground = tabCloseBtnColor
            cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
            border = EmptyBorder(0, 6, 0, 8)
            toolTipText = "Close"
            // Lock close button size — keep it sticky to EAST regardless of title.
            maximumSize = Dimension(preferredSize.width, preferredSize.height)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (SwingUtilities.isLeftMouseButton(e)) {
                        closeChatTab(state, serverSessionId)
                    }
                }
                override fun mouseEntered(e: MouseEvent) { foreground = tabCloseBtnHoverColor }
                override fun mouseExited(e: MouseEvent) { foreground = tabCloseBtnColor }
            })
        }
        // Per A3.6: double-click title to rename.
        titleLabel.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                when {
                    SwingUtilities.isLeftMouseButton(e) && e.clickCount == 2 -> {
                        startRename(state, serverSessionId, titleLabel, displayTitle)
                    }
                    SwingUtilities.isLeftMouseButton(e) && e.clickCount == 1 -> {
                        activateTab(state, serverSessionId)
                    }
                    SwingUtilities.isRightMouseButton(e) -> {
                        showTabContextMenu(state, serverSessionId, titleLabel, e)
                    }
                }
            }
        })
        val tabPanel = object : JPanel() {
            override fun paintComponent(g: Graphics) {
                val g2 = g.create() as? Graphics2D ?: return
                val isActive = getClientProperty("tabActive") as? Boolean == true
                val isHover = getClientProperty("tabHover") as? Boolean == true
                g2.color = if (isHover && !isActive) tabHoverBgColor else tabBgColor
                g2.fillRect(0, 0, width, height)
                if (isActive) {
                    g2.color = tabActiveBorderColor
                    g2.fillRect(0, height - tabActiveBorderHeight, width, tabActiveBorderHeight)
                }
                g2.dispose()
                super.paintComponent(g)
            }
        }.apply {
            layout = BorderLayout()
            isOpaque = false
            putClientProperty("tabActive", false)
        }
        // Inner row: BorderLayout so the × button is hard-anchored to the right.
        val center = JPanel(BorderLayout()).apply { isOpaque = false }
        center.add(titleLabel, BorderLayout.CENTER)
        center.add(closeBtn, BorderLayout.EAST)
        tabPanel.add(center, BorderLayout.CENTER)

        val prefWidth = tabPanel.preferredSize.width
        tabPanel.maximumSize = Dimension(prefWidth, tabBarHeight)

        val hoverListener = tabHoverListener(tabPanel)
        tabPanel.addMouseListener(hoverListener)
        center.addMouseListener(hoverListener)
        tabPanel.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (SwingUtilities.isLeftMouseButton(e) && e.clickCount == 1) {
                    activateTab(state, serverSessionId)
                }
            }
        })
        state.chatTabPanels[serverSessionId] = tabPanel
        state.chatTabsPanel.add(tabPanel)
        // Auto-scroll to show the newly added tab
        SwingUtilities.invokeLater {
            val sb = state.chatTabsScrollPane.horizontalScrollBar
            sb.value = sb.maximum
        }
        // Per A3.8: register with SessionTabManager (close → dispose JCEF + kill worker).
        state.sessionTabManager.register(
            serverSessionId = serverSessionId,
            title = displayTitle,
            onClose = {
                SwingUtilities.invokeLater { performCloseTab(state, serverSessionId) }
            },
        )
        revalidateTabBar(state)
    }

    /**
     * Per A1 + D9: close chat tab.
     * - Dispose JCEF browser (release Chromium process)
     * - Call server `POST /api/sessions/:id/close` → `workerPool.kill(id, 'tab-closed')` (NOT archive)
     * - Clean up Kotlin-side state (SessionTabManager, chatSessions map, tab panel)
     */
    private fun closeChatTab(state: WindowState, serverSessionId: String) {
        state.sessionTabManager.close(serverSessionId)  // triggers onClose → performCloseTab
        if (!state.sessionTabManager.isOpen(serverSessionId)) {
            performCloseTab(state, serverSessionId)
        }
    }

    private fun performCloseTab(state: WindowState, serverSessionId: String) {
        state.chatSessions.remove(serverSessionId)?.dispose()
        state.chatTabPanels.remove(serverSessionId)?.let { panel ->
            state.chatTabsPanel.remove(panel)
        }
        if (state.activeTabId == serverSessionId) {
            state.activeTabId = if (state.chatSessions.isEmpty()) "agents" else state.chatSessions.keys.first()
            activateTab(state, state.activeTabId)
        }
        revalidateTabBar(state)
        // Fire-and-forget: ask server to kill worker (server logs warning if worker missing).
        Thread {
            try {
                com.piagent.idea.server.ServerApiClient(settings.serverOrigin())
                    .closeSession(serverSessionId)
            } catch (e: Exception) {
                PluginLogger.warn("closeSession failed for $serverSessionId: ${e.message}")
            }
        }.start()
    }

    /**
     * Per A3.6: double-click chat tab title to rename (in-place text field).
     * Enter submits, Escape cancels.
     *
     * The titleLabel now lives in a BorderLayout inner panel (CENTER slot), so
     * the swap uses BorderLayout.CENTER add/remove rather than a positional
     * index add (which BorderLayout ignores anyway).
     */
    private fun startRename(state: WindowState, serverSessionId: String, titleLabel: JLabel, currentTitle: String) {
        val container = titleLabel.parent as? JPanel ?: return
        val editor = JTextField(currentTitle).apply {
            font = titleLabel.font
            border = EmptyBorder(2, 4, 2, 4)
            selectAll()
        }
        container.remove(titleLabel)
        container.add(editor, BorderLayout.CENTER)
        container.revalidate()
        editor.requestFocusInWindow()
        var committed = false
        fun commit() {
            if (committed) return
            committed = true
            val newTitle = editor.text.trim().take(200)
            container.remove(editor)
            container.add(titleLabel, BorderLayout.CENTER)
            titleLabel.text = newTitle.ifBlank { currentTitle }
            container.revalidate()
            if (newTitle.isNotBlank() && newTitle != currentTitle) {
                Thread {
                    try {
                        com.piagent.idea.server.ServerApiClient(settings.serverOrigin())
                            .renameSession(serverSessionId, newTitle)
                    } catch (e: Exception) {
                        PluginLogger.warn("renameSession failed for $serverSessionId: ${e.message}")
                    }
                }.start()
            }
        }
        fun cancel() {
            if (committed) return
            committed = true
            container.remove(editor)
            container.add(titleLabel, BorderLayout.CENTER)
            container.revalidate()
        }
        editor.addActionListener { commit() }
        editor.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ESCAPE) { e.consume(); cancel() }
            }
        })
        editor.addFocusListener(object : FocusAdapter() {
            override fun focusLost(e: FocusEvent) { commit() }
        })
    }

    /**
     * Per A3.6: right-click chat tab → context menu (Rename / Close).
     *
     * Title label is the first JLabel inside the inner BorderLayout panel;
     * close button (also JLabel) is the second component.
     */
    private fun showTabContextMenu(state: WindowState, serverSessionId: String, invoker: Component, e: MouseEvent) {
        val menu = JPopupMenu()
        val titleLabel = state.chatTabPanels[serverSessionId]?.let { panel ->
            panel.components.find { it is JPanel }?.let { (it as JPanel).components.find { c -> c is JLabel } as? JLabel }
        }
        menu.add(JMenuItem("Rename").apply {
            addActionListener {
                if (titleLabel != null) {
                    val current = titleLabel.text
                    startRename(state, serverSessionId, titleLabel, current)
                }
            }
        })
        menu.add(JMenuItem("Close").apply {
            addActionListener { closeChatTab(state, serverSessionId) }
        })
        menu.show(invoker, e.x, e.y)
    }

    private fun addSeparator(target: JPanel?) {
        target?.add(JPanel().apply {
            background = tabSeparatorColor
            preferredSize = Dimension(1, tabBarHeight - 4)
            maximumSize = Dimension(1, tabBarHeight - 4)
            isOpaque = true
        })
    }

    private fun activateTab(state: WindowState, tabId: String) {
        state.activeTabId = tabId
        state.body.removeAll()
        when (tabId) {
            "agents" -> {
                state.agentPanel.reload()
                state.body.add(state.agentPanel, BorderLayout.CENTER)
            }
            "sessions" -> {
                state.sessionPanel.reload()
                state.body.add(state.sessionPanel, BorderLayout.CENTER)
            }
            else -> {
                state.chatSessions[tabId]?.let { chat ->
                    state.body.add(chat, BorderLayout.CENTER)
                }
            }
        }
        state.body.revalidate()
        state.body.repaint()
        refreshTabActiveVisual(state)
    }

    private fun revalidateTabBar(state: WindowState) {
        state.chatTabsScrollPane.viewport.revalidate()
        state.tabBar.revalidate()
        state.tabBar.repaint()
    }

    private fun refreshTabActiveVisual(state: WindowState) {
        for ((tabId, btn) in state.fixedTabButtons) {
            val active = tabId == state.activeTabId
            val current = btn.getClientProperty("tabActive") as? Boolean ?: false
            if (current != active) {
                btn.putClientProperty("tabActive", active)
                btn.repaint()
            }
        }
        for ((serverSessionId, panel) in state.chatTabPanels) {
            val active = serverSessionId == state.activeTabId
            val current = panel.getClientProperty("tabActive") as? Boolean ?: false
            if (current != active) {
                panel.putClientProperty("tabActive", active)
                panel.repaint()
            }
        }
    }

    private fun tabHoverListener(target: JComponent): MouseAdapter = object : MouseAdapter() {
        override fun mouseEntered(e: MouseEvent) {
            val current = target.getClientProperty("tabHoverCount") as? Int ?: 0
            target.putClientProperty("tabHoverCount", current + 1)
            if (current == 0) {
                target.putClientProperty("tabHover", true)
                target.repaint()
            }
        }
        override fun mouseExited(e: MouseEvent) {
            val current = (target.getClientProperty("tabHoverCount") as? Int ?: 1).coerceAtLeast(1)
            val next = current - 1
            target.putClientProperty("tabHoverCount", next)
            if (next == 0) {
                target.putClientProperty("tabHover", false)
                target.repaint()
            }
        }
    }

    // ── Chat tab management ──

    private fun onNewSessionFromAgent(state: WindowState, agentId: String) {
        val project = state.project
        Thread {
            val client = com.piagent.idea.server.ServerApiClient(settings.serverOrigin())
            val placeholderId = client.createPlaceholderSession(agentId)
            if (placeholderId == null) {
                showErrorInBody(state, "Failed to create placeholder session (check server URL)")
                return@Thread
            }
            SwingUtilities.invokeLater {
                openChatTab(state, serverSessionId = placeholderId, title = null, agentId = agentId)
            }
        }.start()
    }

    private fun onOpenSession(state: WindowState, session: com.piagent.idea.server.ServerApiClient.Session) {
        if (state.chatSessions.containsKey(session.id)) {
            activateTab(state, session.id)
            return
        }
        Thread {
            val client = com.piagent.idea.server.ServerApiClient(settings.serverOrigin())
            val historyJson = client.getSessionMessagesJson(session.id)
            SwingUtilities.invokeLater {
                openChatTab(
                    state,
                    serverSessionId = session.id,
                    title = session.title,
                    agentId = session.agentId,
                    historyJson = historyJson,
                )
            }
        }.start()
    }

    private fun openChatTab(
        state: WindowState,
        serverSessionId: String,
        title: String?,
        agentId: String,
        historyJson: String? = null,
    ) {
        val project = state.project
        val bridge = IdeaIdeBridge(project)
        val chatPanel = JcefChatPanel(
            project = project,
            serverUrl = settings.serverOrigin(),
            sessionId = serverSessionId,
            agentId = agentId,
            bridge = bridge,
            historyJson = historyJson,
        )
        state.chatSessions[serverSessionId] = chatPanel
        addChatTab(state, serverSessionId, title)
        activateTab(state, serverSessionId)
    }

    private fun showErrorInBody(state: WindowState, message: String) {
        SwingUtilities.invokeLater {
            state.body.removeAll()
            val errPanel = JPanel(BorderLayout()).apply {
                border = EmptyBorder(20, 20, 20, 20)
            }
            val label = JLabel("<html><body style='width:400px'>$message</body></html>").apply {
                foreground = tabErrorColor
            }
            errPanel.add(label, BorderLayout.CENTER)
            val back = JButton("返回 Agents").apply {
                addActionListener { activateTab(state, "agents") }
            }
            errPanel.add(back, BorderLayout.SOUTH)
            state.body.add(errPanel, BorderLayout.CENTER)
            state.body.revalidate()
            state.body.repaint()
        }
    }

    /**
     * Pop the AgentDialog modal — Create mode (existing == null) or Edit mode.
     * After successful save, refresh the AgentPanel so the user sees the
     * updated row. Works for both modes — reload() re-fetches the list and
     * any changed row repaints with new fields.
     *
     * `state` identifies which project's panel triggered the dialog. Without
     * it the dialog would resolve the wrong project (factory singleton — see
     * class doc).
     */
    private fun showAgentDialog(state: WindowState, existing: com.piagent.idea.server.ServerApiClient.Agent?) {
        // ToolWindowFactory itself isn't a Component — anchor the modal to the
        // agent panel (any component in our tree works), then resolve its Frame ancestor.
        val anchor = state.agentPanel
        val owner = SwingUtilities.getWindowAncestor(anchor) as? Frame ?: return
        val projectPath = state.project.basePath ?: ""
        val client = com.piagent.idea.server.ServerApiClient(settings.serverOrigin())
        AddAgentDialog(owner, client, projectPath, existing) { saved ->
            state.agentPanel.reload()
            PluginLogger.info(
                "Agent ${if (existing == null) "created" else "updated"}: ${saved.name} (id=${saved.id})"
            )
        }.also { dialog ->
            dialog.isVisible = true
        }
    }

    /**
     * Confirm-then-delete dialog for an agent. The cascade (kill session
     * workers + unlink pi session files + drop session rows) happens
     * server-side; this just surfaces the result to the user.
     */
    private fun confirmAndRemoveAgent(state: WindowState, agent: com.piagent.idea.server.ServerApiClient.Agent) {
        val confirm = javax.swing.JOptionPane.showConfirmDialog(
            state.agentPanel,
            "Remove agent \"${agent.name}\"?\n\n" +
                "This will:\n" +
                "  • kill any active session workers\n" +
                "  • delete every pi session file on disk for this agent\n" +
                "  • remove all session rows + the agent row from the database\n\n" +
                "This cannot be undone.",
            "Remove agent",
            javax.swing.JOptionPane.OK_CANCEL_OPTION,
            javax.swing.JOptionPane.WARNING_MESSAGE,
        )
        if (confirm != javax.swing.JOptionPane.OK_OPTION) return
        Thread {
            val client = com.piagent.idea.server.ServerApiClient(settings.serverOrigin())
            val result = client.deleteAgent(agent.id)
            SwingUtilities.invokeLater {
                if (result == null) {
                    javax.swing.JOptionPane.showMessageDialog(
                        state.agentPanel,
                        "Failed to remove agent (see IDEA log for details).",
                        "Remove agent",
                        javax.swing.JOptionPane.ERROR_MESSAGE,
                    )
                } else {
                    state.agentPanel.reload()
                    state.sessionPanel.reload()
                    if (result.errors.isNotEmpty()) {
                        javax.swing.JOptionPane.showMessageDialog(
                            state.agentPanel,
                            "Agent removed. ${result.deletedSessions} session(s) deleted, but some cleanup errors:\n\n" +
                                result.errors.joinToString("\n"),
                            "Remove agent",
                            javax.swing.JOptionPane.WARNING_MESSAGE,
                        )
                    }
                }
            }
        }.start()
    }
}