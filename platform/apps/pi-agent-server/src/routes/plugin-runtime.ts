/**
 * 运行期扩展点查询 + 插件端点分发器（change: plugin-runtime-extensions）。
 *
 * 两条边界在这里最明显：
 * - `GET /api/extensions` 只回全局注册（菜单/页面），不碰会话
 * - `/api/p/**` 是**唯一一条**面向插件的分发路由：Hono 的路由表在首次请求后
 *   冻结，插件是运行期装载的，所以不能在装载时 `app.route()`。
 */

import { Hono } from 'hono';
import type { GlobalExtensionsResponse } from '@pi-agent-platform/api-types';
import { childLogger } from '../logger.js';
import { dispatchPluginRoute, hasRoutes, listGlobalExtensions, listPluginIds } from '../services/plugin-extensions.js';
import { killSwitchActive, getPluginSnapshot } from '../services/plugins.js';

const logger = childLogger('plugin-runtime');

export interface PluginRuntimeRouterDeps {
  pluginsDir: string;
}

/** `GET /api/extensions` */
export function createExtensionsRouter(deps: PluginRuntimeRouterDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    if (killSwitchActive()) {
      const body: GlobalExtensionsResponse = { menus: [], pages: [], disabledByFlag: true };
      return c.json(body);
    }
    const { menus, pages } = listGlobalExtensions();
    const body: GlobalExtensionsResponse = {
      menus: menus.map(({ pluginId, def }) => ({ pluginId, ...def })),
      pages: pages.map(({ pluginId, def }) => ({ pluginId, ...def })),
      disabledByFlag: false,
    };
    return c.json(body);
  });

  // 调试：强制重读插件目录（不装/卸插件，只是立刻重算快照）
  app.get('/reload', (c) => {
    getPluginSnapshot(deps.pluginsDir);
    return c.json({ reloaded: true });
  });

  return app;
}

/**
 * `/api/p/**` —— 插件 HTTP 端点分发器。
 *
 * - 前缀与插件 id 绑定：插件无法注册别人的路径
 * - 按"已注册 id 的最长前缀"切分，作用域包名（`@scope/name`，自带 `/`）也支持
 * - handler 抛错 → 500 + 带 pluginId 的日志，不影响其他插件
 * - `enabled: false` / kill switch → 整段 404
 */
export function createPluginDispatcherRouter(deps: PluginRuntimeRouterDeps): Hono {
  const app = new Hono();

  const isEnabled = (id: string): boolean => {
    if (killSwitchActive()) return false;
    const plugin = getPluginSnapshot(deps.pluginsDir).plugins.find((p) => p.entry.id === id);
    return Boolean(plugin && plugin.status === 'active' && plugin.facets.server);
  };

  app.all('/*', async (c) => {
    const fullPath = c.req.path;
    const after = fullPath.startsWith('/api/p/') ? fullPath.slice('/api/p/'.length) : '';
    const candidates = listPluginIds(deps.pluginsDir).filter(
      (id) => after === id || after.startsWith(`${id}/`),
    );
    const pluginId = candidates.sort((a, b) => b.length - a.length)[0];
    if (!pluginId) {
      return c.json({ error: 'no such plugin route', path: after }, 404);
    }
    const path = after.slice(pluginId.length) || '/';

    if (!isEnabled(pluginId)) {
      return c.json({ error: 'plugin endpoint not available', pluginId }, 404);
    }

    try {
      const result = await dispatchPluginRoute(
        pluginId,
        {
          path,
          method: c.req.method,
          query: Object.fromEntries(new URL(c.req.url).searchParams.entries()),
          body: c.req.method === 'GET' || c.req.method === 'HEAD' ? '' : await c.req.text(),
          headers: c.req.raw.headers,
        },
        isEnabled,
      );

      if (result === null) {
        return c.json(
          { error: 'no such plugin route', pluginId, path, hasRoutes: hasRoutes(pluginId) },
          404,
        );
      }
      if (result === 'not-enabled') {
        return c.json({ error: 'plugin endpoint not available', pluginId }, 404);
      }
      if (result === 'not-found') {
        return c.json({ error: 'no such plugin route', pluginId, path }, 404);
      }

      const status = result.status ?? 200;
      const headers = new Headers(result.headers);
      if (result.body !== undefined) {
        return new Response(result.body, { status, headers });
      }
      headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json; charset=UTF-8');
      return new Response(JSON.stringify(result.json ?? {}), { status, headers });
    } catch (err) {
      logger.error({ pluginId, path, err: String(err) }, 'plugin route handler failed');
      return c.json({ error: 'plugin handler failed', pluginId, detail: String(err).split('\n')[0] }, 500);
    }
  });

  return app;
}
