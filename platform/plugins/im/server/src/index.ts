/**
 * IM 网关（bundled 插件）。
 *
 * 这个子系统以前长在 server 入口里（`apps/pi-agent-server/src/im-gateway/`，1874 行 +
 * `channels/` 3000 行 + `packages/channel-types`）。按"做减法"的判据 —— **把它
 * `enabled:false` 之后平台还能建 agent、开会话、聊完一轮** —— 它是插件。
 *
 * 本插件负责：连接注册表 / 会话绑定（文件持久化）/ 会话订阅管理 / 回复过滤与聚合 /
 * 投递 / IM 页 / `sendFileToUser`。对**具体渠道零知识**：渠道是别的插件，通过
 * `im.channel` namespace 上的 service 接入（契约形状见 `channel-api.ts`）。
 *
 * 30 分钟空闲回收**已移除**：网关不做 worker 回收（那条策略历史上就不该在这里）。
 */

import type { PluginServerHost } from '@pi-agent-platform/plugin-types';
import { createGateway } from './gateway.js';
import { registerRoutes } from './routes.js';
import { createStateStore } from './state.js';

export default {
  init(host: PluginServerHost) {
    const state = createStateStore(host.dataDir, (level, msg, extra) => {
      if (level === 'warn') host.log('warn', msg, extra);
      else host.log('info', msg, extra);
    });

    const gateway = createGateway({ host, state });

    // ── 页面：一级入口就是网关页（二级项「网关」指回自己，与 /config 同构）──
    host.ui.page({ path: '/im', label: 'IM', icon: 'im', component: 'gateway', parent: '/config', order: 30 });

    // ── 端点：连接 / 绑定 / SSE 日志 ──
    registerRoutes(host.http.route, gateway);

    // ── 动作：sendFileToUser（工具名不变，反向方法 `im.sendFile`）──
    host.actions.define({
      sendFile: {
        scope: 'own',
        params: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Absolute path to the file to send' },
            fileName: {
              type: 'string',
              description:
                'Friendly display name without extension (system auto-appends the correct extension from the actual file)',
            },
          },
          required: ['filePath'],
          additionalProperties: false,
        },
        tool: {
          name: 'sendFileToUser',
          description:
            'Send a file to the user through the active IM channel (QQ / WeChat). Use absolute paths inside the workspace.',
          exposure: 'direct',
          namespace: 'im',
          promptSnippet: 'Send a file to the user via IM',
          promptGuidelines: [
            'Use sendFileToUser when the user should receive an actual file (report, image, archive) rather than a path in chat.',
          ],
        },
        handler: async (params, ctx) => {
          const p = (params ?? {}) as { filePath?: string; fileName?: string };
          const filePath = (p.filePath ?? '').trim();
          if (!filePath) throw new Error('sendFileToUser: filePath required');
          const sessionId = ctx.sessionId;
          if (!sessionId) throw new Error('sendFileToUser: 只在会话内可用');
          const result = await gateway.sendFileToSession(sessionId, { filePath });
          if (!result.ok) throw new Error(result.reason ?? 'sendFileToUser failed');
          return { ok: true, filePath };
        },
      },
    });

    // ── 渠道发现：快照 + 插件级事件（低频；注册级事件会爆炸，所以不做）──
    const offLoaded = host.bus.subscribe('__core__.plugin.loaded', () => void gateway.rescan());
    const offUnloaded = host.bus.subscribe('__core__.plugin.unloaded', () => void gateway.rescan());
    void gateway.rescan();

    host.log('info', 'IM 网关已就绪', { dataDir: host.dataDir, stateFile: state.file });

    return async () => {
      offLoaded.dispose();
      offUnloaded.dispose();
      await gateway.dispose();
    };
  },
};
