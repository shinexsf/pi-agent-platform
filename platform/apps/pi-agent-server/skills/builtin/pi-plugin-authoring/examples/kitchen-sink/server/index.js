/**
 * server facet —— 扩展点全景（顶栏动作 / 会话槽位 / 工具卡片 / HTTP 端点 / 广播 / 定向调用）。
 *
 * 注意三条硬约束：
 * 1. 所有注册都在 init(host) 里完成 —— 路由表首次请求后冻结，运行期再注册会抛错
 * 2. 注册项 id 在同一（作用域, 类别）内唯一，重复注册后者进 `rejected`（不静默）
 * 3. 路由路径精确匹配、不支持通配符；请求体是原始文本，要 JSON 自己 parse
 */

export default {
  init(host) {
  // ── R11 顶栏动作：图标按钮 + 点开的面板（PC 平铺 / 移动端收进「更多」）───────
  host.ui.headerAction({
    id: 'demo-hdr',
    icon: 'automation',
    title: '顶栏动作示例',
    component: 'hdr',
    order: 50,
  });

  // ── 会话页右侧轨道槽位：声明一次 = 轨道按钮 + 抽屉面板 ───────────────────
  host.session.surfaces.register({
    id: 'kitchen-sink',
    slot: 'chat.rail.right', // 目前唯一槽位
    title: '示例面板',
    icon: 'layers',
    order: 10,
    entry: 'panel', // → web/panel.js
  });

  // ── 接管某个工具的卡片渲染（mode: 'replace' 整卡替换；'regions' 只换局部）──
  host.session.toolCards.register({
    tool: 'sendFileToUser',
    match: 'exact', // 或 'prefix'，例如 mcp__xx__ 前缀
    mode: 'replace',
    entry: 'card', // → web/card.js
  });

  // ── HTTP 端点示例：POST 回声（演示原始 body 自己 parse）──
  host.global.routes.register({
    method: 'POST',
    path: '/echo',
    handler: (req) => {
      let parsed = null;
      try {
        parsed = req.body ? JSON.parse(req.body) : null;
      } catch {
        return { status: 400, json: { error: 'body 不是合法 JSON（平台不会替你解析）' } };
      }
      return { json: { received: parsed, contentType: req.header('content-type') ?? null } };
    },
  });

  // ── 广播：声明一个 topic（前缀 MUST 是本插件 id；publisher 型 = 只有你能发）──
  // 订阅方即使比你先装载也不会漏：它那侧处于 pending，你 declare 后自动接上。
  host.bus.declare('kitchen-sink.demo.done', { declaredBy: 'publisher' });

  // ── 定向调用：对外提供能力（短名由宿主补成本插件前缀）─────────────────
  // 别的插件：const n = await host.services.call('kitchen-sink.demo.count', {});
  let count = 0;
  host.services.provide('demo.count', () => {
    count += 1;
    return { count, at: new Date().toISOString() };
  });

  // （触发器扩展点在触发器子系统下线时一并移除；插件化后重新引入）

  host.log('info', 'kitchen-sink registered');
  },
};
