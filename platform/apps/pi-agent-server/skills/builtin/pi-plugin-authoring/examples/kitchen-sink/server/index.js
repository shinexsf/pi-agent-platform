/**
 * server facet —— 扩展点全景（会话槽位 / 工具卡片 / 触发器来源 / 进程内触发）。
 *
 * 注意三条硬约束：
 * 1. 所有注册都在 init(host) 里完成 —— 路由表首次请求后冻结，运行期再注册会抛错
 * 2. 注册项 id 在同一（作用域, 类别）内唯一，重复注册后者进 `rejected`（不静默）
 * 3. 路由路径精确匹配、不支持通配符；请求体是原始文本，要 JSON 自己 parse
 */

export function init(host) {
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

  // ── HTTP 端点示例：GET 列触发器 / POST 回声（演示原始 body 自己 parse）──
  host.global.routes.register({
    method: 'GET',
    path: '/triggers',
    handler: () => ({ json: host.triggers.list({ includeDisabled: false }) }),
  });

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

  // ── 进程内触发一次已有触发器（不需要 secret，不走 HTTP）─────────────────
  host.global.routes.register({
    method: 'POST',
    path: '/fire',
    handler: async (req) => {
      let triggerId;
      try {
        triggerId = JSON.parse(req.body || '{}').triggerId;
      } catch {
        return { status: 400, json: { error: 'body 需为 {"triggerId":"..."}' } };
      }
      if (!triggerId) return { status: 400, json: { error: 'triggerId 必填' } };
      const result = await host.triggers.fire(triggerId, { from: 'kitchen-sink' });
      return { json: result };
    },
  });

  // ── 注册一种新的触发器来源（与内置 cron/once/webhook 同一张注册表）──────
  //    只描述「配置校验 + 下次时间 + 清理」，不含 HTTP 路由。
  host.triggerSources.register({
    source: 'demo-every-n-min',
    label: '每 N 分钟（示例）',
    description: '示例来源：按 config.everyMinutes 从现在起算下一次时间',
    validateConfig(config) {
      const every = Number(config && config.everyMinutes);
      if (!Number.isFinite(every) || every < 1) throw new Error('everyMinutes 必须是 ≥1 的整数');
      return { everyMinutes: Math.floor(every) };
    },
    computeNextAt(config, from) {
      return from + Number(config.everyMinutes) * 60_000;
    },
    defaultMaxRuns: null,
  });

  host.log('info', 'kitchen-sink registered');
}
