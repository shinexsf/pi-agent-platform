/**
 * channel-mock —— 渠道插件的**参考实现**（最小可跑）。
 *
 * 渠道与网关是两个插件，只靠 `im.channel` 这个 namespace 相连：
 *   渠道侧：`services.provide('<你的插件 id>.channel', factory, { namespace: 'im.channel' })`
 *   网关侧：`services.list({ namespace: 'im.channel' })` → `services.call(name, { uplink })`
 *
 * 三条边界（照抄即可，别越界）：
 * 1. 渠道**不认识 agent、不认识 session** —— 消息只走 `uplink.onInbound`
 * 2. 连接定义在**自己的配置文件**里，不放库表；`enabled` / `agentId` 是网关的事
 * 3. 能力用**可选方法**表达（`sendFile?` 存在 = 支持发文件），不占额外 namespace
 *
 * 这个 mock 不连任何真实平台：它收到 `uplink.onInbound` 的调用记录，并把「网关投递了什么」
 * 存进内存供 curl 断言。真实渠道把 record() 换成 SDK 调用即可。
 */

const NAMESPACE = 'im.channel';
const API_VERSION = 1;

/** 假配置：真实渠道从 config.json 读。 */
const connections = [{ id: 'mock-1', label: 'Mock 1' }];

let uplink = null;
const outbox = [];

function makeDriver() {
  return {
    apiVersion: API_VERSION,
    type: 'mock',
    label: 'Mock',
    connections: () => connections,
    async connect(connectionId) {
      uplink?.onStatus({ connectionId, status: 'connected' });
    },
    async disconnect(connectionId) {
      uplink?.onStatus({ connectionId, status: 'disconnected' });
    },
    async send(connectionId, chatId, payload) {
      outbox.push({ connectionId, chatId, payload });
    },
    // 可选能力：去掉这个方法，网关就会退回"发路径文本"。
    async sendFile(connectionId, chatId, payload) {
      outbox.push({ connectionId, chatId, payload: { kind: 'file', ...payload } });
    },
  };
}

export default {
  init(host) {
    // 新增连接的 UI 归渠道自己：注册插件空间槽位，宿主页（IM 网关）会装载 web/create.js
    host.ui.slot({ slot: 'im.channel.create', id: 'mock-create', title: 'Mock', component: 'create', order: 90 });

    host.services.provide(
      `<你的插件 id>.channel`,
      async (payload) => {
        uplink = payload.uplink;
        // 装载时把配置里的连接逐条声明（网关不持久化连接清单）。
        for (const meta of connections) uplink.declare(meta);
        return makeDriver();
      },
      { namespace: NAMESPACE },
    );

    // 探针端点：模拟"外部来了消息"（真实渠道里是 SDK 的回调）
    host.http.route({
      method: 'POST',
      path: '/inject',
      handler: async (req) => {
        const body = JSON.parse(req.body || '{}');
        await uplink.onInbound({
          connectionId: body.connectionId,
          chatId: body.chatId,
          text: String(body.text ?? ''),
        });
        return { json: { ok: true } };
      },
    });

    host.http.route({ method: 'GET', path: '/outbox', handler: () => ({ json: { outbox } }) });

    // 二级页面：挂在 IM 一级菜单下（只做新增 / 删除）
    host.ui.page({ path: '/im/mock', label: 'Mock', component: 'channels', parent: '/im' });
  },
};
