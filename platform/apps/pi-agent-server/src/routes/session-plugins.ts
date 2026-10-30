/**
 * 会话作用域的插件上行入口（change: plugin-mechanism 5.4 的服务端一半）。
 *
 * `POST /api/sessions/:id/plugins/:pluginId/emit`
 * 浏览器 → worker：只透传 `{ name, data }` 给插件自己注册的 handler。
 *
 * 刻意不做的事：
 * - 不解释 `name`（插件自由定义）
 * - 不做鉴权语义（浏览器本身就是不可信输入源，插件 handler 自己校验）
 * - 会话不在跑时**不报错**，返回 `handled: false`（worker 可能已被回收，
 *   插件面板不该因此弹错）
 */

import { Hono } from 'hono';
import type { WorkerPool } from '../worker-pool.js';
import { childLogger } from '../logger.js';

const logger = childLogger('plugin-emit');

export interface SessionPluginsRouterDeps {
  workerPool: WorkerPool;
}

export function createSessionPluginsRouter(deps: SessionPluginsRouterDeps): Hono {
  const app = new Hono();

  app.post('/:id/plugins/emit', async (c) => {
    const sessionId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      pluginId?: unknown;
      name?: unknown;
      data?: unknown;
    };
    // pluginId 走 body 而不是路径：npm 包名里带 `/`（如 `@probe/hud-demo`），
    // 塞进路径会被 `%2F` 编码，导致按 id 查不到接收者。
    if (typeof body.pluginId !== 'string' || !body.pluginId) {
      return c.json({ error: 'pluginId is required' }, 400);
    }
    if (typeof body.name !== 'string' || !body.name) {
      return c.json({ error: 'name is required' }, 400);
    }
    const { pluginId } = body;
    try {
      const handled = await deps.workerPool.call<boolean>(sessionId, 'pluginEmit', [
        pluginId,
        body.name,
        body.data ?? null,
      ]);
      return c.json({ handled: Boolean(handled) });
    } catch (err) {
      logger.warn({ sessionId, pluginId, err: String(err) }, 'plugin emit could not reach worker');
      return c.json({ handled: false });
    }
  });

  return app;
}
