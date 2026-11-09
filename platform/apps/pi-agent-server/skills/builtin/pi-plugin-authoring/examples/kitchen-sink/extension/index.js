/**
 * extension facet —— 作为 **pi 扩展** 在 worker 进程里装载。
 *
 * 入口签名：默认导出 async (pi, { bridge }) => { ... }
 *   pi     —— pi 的 ExtensionAPI（registerTool / registerCommand / on(...) 等）
 *   bridge —— 与 worker facet 相同的上行桥（可用于把工具进度推给浏览器）
 *
 * 与 worker facet 的区别：这里能注册工具/命令/事件钩子；worker facet 只能旁观。
 * 加载失败只隔离自己（会话继续），所以别在顶层抛错。
 */

export default async function extension(pi, { bridge }) {
  // 注册一个工具（参数用 JSON Schema；pi 内部按 TypeBox 形状消费）
  pi.registerTool({
    name: 'demo_echo',
    label: 'Demo Echo',
    description: '回声工具：原样返回传入的 text。用于验证插件工具是否装载成功。',
    promptSnippet: 'demo_echo: 回声工具（验证插件装载）',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      // 把进度/结果推给浏览器（panel.js 的 data.subscribe 能收到）
      bridge.emit('tool_called', { text: params.text });
      return {
        content: [{ type: 'text', text: `echo: ${params.text}` }],
        details: { echoed: params.text },
      };
    },
  });

  bridge.log('info', 'extension facet registered demo_echo');
}
