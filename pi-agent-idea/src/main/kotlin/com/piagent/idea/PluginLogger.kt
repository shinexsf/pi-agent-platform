package com.piagent.idea

import com.intellij.openapi.diagnostic.Logger
import java.io.BufferedWriter
import java.io.FileWriter
import java.io.PrintWriter
import java.text.SimpleDateFormat
import java.util.*

class PluginLogger {

    private val logFile = java.io.File(System.getProperty("user.home"), ".pi-agent-plugin/plugin.log")
    private val dateFormat = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS")

    init {
        logFile.parentFile.mkdirs()
    }

    fun info(message: String) {
        write("INFO", message)
    }

    fun warn(message: String) {
        write("WARN", message)
    }

    fun error(message: String, throwable: Throwable? = null) {
        write("ERROR", message)
        if (throwable != null) {
            val sw = java.io.StringWriter()
            throwable.printStackTrace(PrintWriter(sw))
            write("ERROR", sw.toString())
        }
    }

    private fun write(level: String, message: String) {
        try {
            val timestamp = dateFormat.format(Date())
            val logLine = "[$timestamp] [$level] $message\n"
            logFile.appendText(logLine)

            // 同时输出到 IntelliJ 日志
            when (level) {
                "INFO" -> Logger.getInstance("PiAgentPlugin").info(message)
                "WARN" -> Logger.getInstance("PiAgentPlugin").warn(message)
                "ERROR" -> Logger.getInstance("PiAgentPlugin").error(message)
            }
        } catch (e: Exception) {
            // ignore
        }
    }

    companion object {
        val instance = PluginLogger()

        fun info(message: String) = instance.info(message)
        fun warn(message: String) = instance.warn(message)
        fun error(message: String, throwable: Throwable? = null) = instance.error(message, throwable)
    }
}
