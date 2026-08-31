package com.piagent.idea.ui

import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefClient
import com.intellij.ui.jcef.JBCefJSQuery
import com.intellij.util.messages.MessageBusConnection
import com.piagent.idea.PluginLogger
import com.piagent.idea.bridge.IdeaIdeBridge
import org.cef.browser.CefBrowser
import org.cef.handler.CefLoadHandlerAdapter
import java.awt.BorderLayout
import javax.swing.JPanel
import javax.swing.SwingUtilities

/**
 * Chat Tab 内的 JCEF 容器。
 * - 每 session 一个 JBCefBrowser 实例（design D2）
 * - loadURL 指向 server `/ide/?sessionId=&agentId=&source=idea`
 * - 页面加载完成后注入 window.__ideBridge（通用 invoke/on/getEnv）
 * - dispose() 释放 Chromium 进程
 *
 * ⚠️ 旧插件踩坑：`window.cefQuery` 不存在！正确用法是 query.inject() 生成 JS 表达式。
 */
class JcefChatPanel(
    private val project: Project,
    private val serverUrl: String,
    private val sessionId: String,
    private val agentId: String,
    private val bridge: IdeaIdeBridge,
    private val historyJson: String? = null,
) : JPanel(BorderLayout()), Disposable {

    private val browser: JBCefBrowser = JBCefBrowser()
    private val jsQuery: JBCefJSQuery = JBCefJSQuery.create(browser)
    private val onJsQuery: JBCefJSQuery = JBCefJSQuery.create(browser)
    private val unsubscribeJsQuery: JBCefJSQuery = JBCefJSQuery.create(browser)
    private var bridgeInjected = false
    private var themeMessageBusConnection: MessageBusConnection? = null

    // Per D5: Kotlin ↔ JS listener registry.
    // Each entry = (eventName, lastActivityMs); unsubscribe removes the entry.
    private val listenerRegistry = java.util.concurrent.ConcurrentHashMap<String, Pair<String, java.util.concurrent.atomic.AtomicLong>>()
    private val listenerCounter = java.util.concurrent.atomic.AtomicLong(0)
    // Idle timeout: listeners unused for 10 min are auto-removed (R3).
    private val listenerIdleTimeoutMs = 10 * 60 * 1000L

    init {
        add(browser.component, BorderLayout.CENTER)

        jsQuery.addHandler { jsonString ->
            handleBridgeCall(jsonString)
            null  // 异步响应：executeJavaScript 触发 Promise resolve
        }

        onJsQuery.addHandler { jsonString ->
            // Per D5: 'on' op returns listenerId via __ideBridgeResolve (same callback table)
            handleBridgeCall(jsonString)
            null
        }

        unsubscribeJsQuery.addHandler { jsonString ->
            handleBridgeCall(jsonString)
            null
        }

        browser.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            override fun onLoadingStateChange(
                browser: CefBrowser?,
                isLoading: Boolean,
                canGoBack: Boolean,
                canGoForward: Boolean,
            ) {
                if (!isLoading && !bridgeInjected) {
                    injectBridge()
                }
            }
        }, browser.cefBrowser)

        // 订阅主题切换（LafManagerListener）
        themeMessageBusConnection = ApplicationManager.getApplication().messageBus.connect()
        themeMessageBusConnection!!.subscribe(
            com.intellij.ide.ui.LafManagerListener.TOPIC,
            LafManagerListener { pushThemeToBrowser() }
        )

        // 加载 server URL（带 query 参数）
        val origin = serverUrl.trimEnd('/')
        val url = "$origin/ide/?sessionId=${sessionId}&agentId=${agentId}&source=idea"
        PluginLogger.info("JcefChatPanel loadURL: $url")
        browser.loadURL(url)

    }

    /** 处理来自 JS 的 bridge 调用（JSON-RPC 风格）。 */
    private fun handleBridgeCall(jsonString: String?) {
        if (jsonString.isNullOrBlank()) return
        PluginLogger.info("BRIDGE received: $jsonString")
        try {
            val mapper = com.fasterxml.jackson.module.kotlin.jacksonObjectMapper()
            val req = mapper.readTree(jsonString)
            val id = req.get("id")?.asText() ?: return
            val op = req.get("op")?.asText()
            when (op) {
                "invoke" -> {
                    val method = req.get("method")?.asText() ?: return
                    val params = req.get("params")
                    val res: IdeaIdeBridge.BridgeResponse<Any?> = bridge.invoke(method, params)
                    resolvePromise(id, res)
                }
                "getEnv" -> {
                    val res: IdeaIdeBridge.BridgeResponse<IdeaIdeBridge.EnvInfo> = bridge.getEnv()
                    resolvePromise(id, res)
                }
                "on" -> {
                    val event = req.get("event")?.asText()
                    if (event.isNullOrBlank()) {
                        resolvePromise(id, IdeaIdeBridge.BridgeResponse<String>(ok = false, error = IdeaIdeBridge.BridgeError("invalid_params", "Missing event name")))
                        return
                    }
                    val listenerId = "L${listenerCounter.incrementAndGet()}"
                    listenerRegistry[listenerId] = event to java.util.concurrent.atomic.AtomicLong(System.currentTimeMillis())
                    resolvePromise(id, IdeaIdeBridge.BridgeResponse<String>(ok = true, data = listenerId))
                    PluginLogger.info("BRIDGE on registered: event=$event id=$listenerId")
                }
                "unsubscribe" -> {
                    val listenerId = req.get("listenerId")?.asText()
                    if (listenerId != null) {
                        listenerRegistry.remove(listenerId)
                        PluginLogger.info("BRIDGE unsubscribed: id=$listenerId")
                    }
                    resolvePromise(id, IdeaIdeBridge.BridgeResponse<Unit>(ok = true))
                }
                else -> {
                    PluginLogger.warn("Unknown bridge op: $op")
                }
            }
        } catch (e: Exception) {
            PluginLogger.warn("Bridge call handling failed: ${e.message}")
        }
    }

    /** Per D5: push event to JS via window.__ideBridgeOnEvent(listenerId, data). */
    private fun pushEventToBrowser(event: String, data: Any?) {
        if (!bridgeInjected) return
        val now = System.currentTimeMillis()
        // Auto-cleanup idle listeners (R3)
        val it = listenerRegistry.entries.iterator()
        while (it.hasNext()) {
            val (id, pair) = it.next()
            if (event == pair.first && now - pair.second.get() > listenerIdleTimeoutMs) {
                it.remove()
                PluginLogger.info("BRIDGE listener auto-removed (idle): id=$id event=${pair.first}")
            }
        }
        // Touch activity timestamps + push to matching listeners
        val mapper = com.fasterxml.jackson.module.kotlin.jacksonObjectMapper()
        val json = mapper.writeValueAsString(data)
        val matchIds = listenerRegistry.entries
            .filter { it.value.first == event }
            .map { it.key to it.value }
        for ((listenerId, pair) in matchIds) {
            pair.second.set(now)
            SwingUtilities.invokeLater {
                try {
                    browser.cefBrowser.executeJavaScript(
                        "if (window.__ideBridgeOnEvent) window.__ideBridgeOnEvent('$listenerId', $json);",
                        browser.cefBrowser.url, 0
                    )
                } catch (e: Exception) {
                    PluginLogger.warn("pushEvent failed for $listenerId: ${e.message}")
                }
            }
        }
    }

    /** Per C2/D3.3.1: receive SSE `queue_update` event from master, push to JS listeners. */
    fun pushQueueUpdateToBrowser(steering: List<String>, followUp: List<String>) {
        pushEventToBrowser(
            com.piagent.idea.bridge.methods.BridgeEvents.SESSION_QUEUE_UPDATE,
            mapOf("steering" to steering, "followUp" to followUp),
        )
    }

    private fun resolvePromise(id: String, res: IdeaIdeBridge.BridgeResponse<*>) {
        val mapper = com.fasterxml.jackson.module.kotlin.jacksonObjectMapper()
        val json = mapper.writeValueAsString(res)
        // 调用页面里的 __ideBridgeResolve(id, result) 触发 Promise resolve
        browser.cefBrowser.executeJavaScript(
            "if (window.__ideBridgeResolve) window.__ideBridgeResolve('$id', $json);",
            browser.cefBrowser.url,
            0,
        )
    }

    /** 把当前 IDE 主题推送到 JCEF 页面。
     *
     * 走全局函数 `window.__applyIdeTheme(json)`（不走 bridge.invoke / listener）。
     * 原因：bridge.invoke 异步 + listener 异步注册，初始主题会在 listener 注册前被推掉。
     * 全局函数总是可用，调后即生效，无时序问题。
     */
    private fun pushThemeToBrowser() {
        val res: IdeaIdeBridge.BridgeResponse<IdeaIdeBridge.ThemeInfo> = bridge.invoke(
            com.piagent.idea.bridge.methods.BridgeMethods.GET_THEME,
            null,
        )
        if (!res.ok || res.data == null) return
        val mapper = com.fasterxml.jackson.module.kotlin.jacksonObjectMapper()
        val json = mapper.writeValueAsString(res.data)
        SwingUtilities.invokeLater {
            browser.cefBrowser.executeJavaScript(
                "if (window.__applyIdeTheme) window.__applyIdeTheme($json);",
                browser.cefBrowser.url, 0
            )
        }
    }

    /** 注入 window.__ideBridge 到页面。 */
    private fun injectBridge() {
        if (bridgeInjected) return
        bridgeInjected = true

        // query.inject 生成的代码会以独立函数调用，arguments[0..2] 是该函数的参数。
        // JS 端需要包一层 wrapper 把 id / method / params 传进去。
        val injectInvoke = jsQuery.inject("JSON.stringify({op:'invoke', id: arguments[0], method: arguments[1], params: arguments[2]})")
        val injectGetEnv = jsQuery.inject("JSON.stringify({op:'getEnv', id: arguments[0]})")
        val injectOn = onJsQuery.inject("JSON.stringify({op:'on', id: arguments[0], event: arguments[1]})")
        val injectUnsubscribe = unsubscribeJsQuery.inject("JSON.stringify({op:'unsubscribe', id: arguments[0], listenerId: arguments[1]})")

        browser.cefBrowser.executeJavaScript(
            """
            (function() {
                if (window.__ideBridgeReady) return;

                // Promise resolver table
                window.__ideBridgeCallbacks = {};
                window.__ideBridgeIdCounter = 0;
                window.__ideBridgeGenerateId = function() {
                    return 'bridge_' + (++window.__ideBridgeIdCounter) + '_' + Date.now();
                };
                window.__ideBridgeResolve = function(id, result) {
                    var cb = window.__ideBridgeCallbacks[id];
                    if (!cb) return;
                    delete window.__ideBridgeCallbacks[id];
                    if (result && result.ok) cb.resolve(result.data);
                    else cb.reject(result && result.error ? result.error : { code: 'unknown', message: 'bridge failed' });
                };

                // Mock invoke via JS Query 注入的表达式
                // query.inject 输出的是 window.__cefQuery_xxx(JSON.stringify(...))，
                // 必须在函数体内调用以让 arguments[0..N] 生效。
                window.__invokeViaBridge = function(method, params) {
                    return new Promise(function(resolve, reject) {
                        var id = window.__ideBridgeGenerateId();
                        window.__ideBridgeCallbacks[id] = { resolve: resolve, reject: reject };
                        try {
                            (function(id, method, params) {
                                $injectInvoke
                            })(id, method, params);
                        } catch (e) {
                            console.error('[bridge] invoke failed:', e);
                            reject({ code: 'invoke_failed', message: String(e) });
                        }
                    });
                };
                window.__getEnvViaBridge = function() {
                    return new Promise(function(resolve, reject) {
                        var id = window.__ideBridgeGenerateId();
                        window.__ideBridgeCallbacks[id] = { resolve: resolve, reject: reject };
                        try {
                            (function(id) {
                                $injectGetEnv
                            })(id);
                        } catch (e) {
                            console.error('[bridge] getEnv failed:', e);
                            reject({ code: 'getenv_failed', message: String(e) });
                        }
                    });
                };
                window.__onViaBridge = function(event) {
                    return new Promise(function(resolve, reject) {
                        var id = window.__ideBridgeGenerateId();
                        window.__ideBridgeCallbacks[id] = { resolve: resolve, reject: reject };
                        try {
                            (function(id, event) {
                                $injectOn
                            })(id, event);
                        } catch (e) {
                            console.error('[bridge] on failed:', e);
                            reject({ code: 'on_failed', message: String(e) });
                        }
                    });
                };
                window.__unsubscribeViaBridge = function(listenerId) {
                    return new Promise(function(resolve, reject) {
                        var id = window.__ideBridgeGenerateId();
                        window.__ideBridgeCallbacks[id] = { resolve: resolve, reject: reject };
                        try {
                            (function(id, listenerId) {
                                $injectUnsubscribe
                            })(id, listenerId);
                        } catch (e) {
                            console.error('[bridge] unsubscribe failed:', e);
                            reject({ code: 'unsubscribe_failed', message: String(e) });
                        }
                    });
                };

                // Public bridge API
                window.__ideBridge = {
                    platform: 'idea',
                    version: '${IdeaIdeBridge.PLUGIN_VERSION}',
                    invoke: function(method, params) { return window.__invokeViaBridge(method, params); },
                    on: function(event, listener) {
                        // Per D5: 真实现：注册 listener 拿 listenerId；返 unsubscribe function。
                        var id = null;
                        window.__onViaBridge(event).then(function(listenerId) {
                            id = listenerId;
                            window.__ideBridgeListeners[listenerId] = listener;
                        });
                        return function() {
                            if (id) window.__unsubscribeViaBridge(id);
                        };
                    },
                    getEnv: function() { return window.__getEnvViaBridge(); },
                };
                window.__ideBridgeListeners = {};
                window.__ideBridgeOnEvent = function(listenerId, data) {
                    var listener = window.__ideBridgeListeners[listenerId];
                    if (listener) listener(data);
                };

                // Per D10 + R3: theme applied via global function (NOT bridge.invoke).
                // Reasons: (1) bridge.invoke is async — race with listener registration.
                //          (2) We need theme applied BEFORE Vue's bindToBridge runs onMounted.
                // The function reads cssVars + sets data-mode, identical to useIdeTheme.applyTheme.
                window.__applyIdeTheme = function(themeJson) {
                    try {
                        var theme = (typeof themeJson === 'string') ? JSON.parse(themeJson) : themeJson;
                        if (!theme || !theme.cssVars) return;
                        var root = document.documentElement;
                        for (var k in theme.cssVars) {
                            if (theme.cssVars[k] != null) root.style.setProperty(k, theme.cssVars[k]);
                        }
                        if (theme.fontFamily) {
                            root.style.setProperty('--font-family', theme.fontFamily);
                        }
                        root.setAttribute('data-mode', theme.mode);
                        window.__lastAppliedTheme = theme;
                        console.log('[theme] __applyIdeTheme: mode=' + theme.mode + ' (' + Object.keys(theme.cssVars).length + ' vars)');
                    } catch (e) {
                        console.error('[theme] __applyIdeTheme failed:', e);
                    }
                };
                window.__ideBridgeReady = true;
                window.dispatchEvent(new CustomEvent('ide-bridge-ready'));
                console.log('[bridge] injected, platform=' + window.__ideBridge.platform);
            })();
            """.trimIndent(),
            browser.cefBrowser.url,
            0,
        )
        PluginLogger.info("Bridge injected via query.inject()")

        // 立即推送当前 IDE 主题（不等 LafManagerListener 触发）
        pushThemeToBrowser()
    }

    override fun dispose() {
        try {
            themeMessageBusConnection?.disconnect()
            listenerRegistry.clear()
            jsQuery.dispose()
            onJsQuery.dispose()
            unsubscribeJsQuery.dispose()
            browser.dispose()
        } catch (e: Exception) {
            PluginLogger.warn("dispose failed: ${e.message}")
        }
    }
}