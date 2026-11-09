/**
 * worker facet —— 在 session worker 进程里执行。
 *
 * 入口：默认导出 activate({ bridge })（也可以是 default 导出函数）。
 * 它不是 pi 扩展：只能通过 bridge 观察/发事件，拿不到 pi 的工具注册面。
 *
 * bridge:
 *   emit(name, data)    worker → 浏览器（经 server SSE，64 KiB / 100 帧每秒硬上限）
 *   onEmit(handler)      浏览器 → worker（同一插件只保留最后一个处理器）
 *   log(level, msg, x)   进平台日志（自动带 pluginId）
 *
 * 加载失败只隔离自己，不影响会话启动；所以这里不要做阻塞式初始化。
 */

export async function activate({ bridge }) {
  bridge.log('info', 'worker facet loaded');

  // 会话开始后主动上行一条，浏览器侧 panel.js 的 data.subscribe 会收到
  bridge.emit('ready', { at: Date.now(), pid: typeof process !== 'undefined' ? process.pid : null });

  // 接收浏览器侧的上行事件，并回一条确认
  bridge.onEmit((name, data) => {
    bridge.log('debug', `browser → worker: ${name}`, { data });
    if (name === 'ping') bridge.emit('pong', { echo: data, at: Date.now() });
  });
}
