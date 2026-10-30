/**
 * `GET /api/plugins` — 插件只读视图（change: plugin-mechanism）。
 *
 * **只读**：安装/卸载/启停只能走 `pi-server plugin`，这里刻意不提供任何写端点。
 */

import { Hono } from 'hono';
import type { ListPluginsResponse } from '@pi-agent-platform/api-types';
import { getPluginSnapshot, loadPlugins, toPluginEntryDTO } from '../services/plugins.js';
export interface PluginsRouterDeps {
  pluginsDir: string;
}

export function createPluginsRouter(deps: PluginsRouterDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const snapshot = getPluginSnapshot(deps.pluginsDir);
    const body: ListPluginsResponse = {
      plugins: snapshot.plugins.map(toPluginEntryDTO),
      disabledByFlag: snapshot.disabledByFlag,
    };
    return c.json(body);
  });

  // 调试：强制重读（不重启 server）
  app.get('/reload', (c) => {
    const snapshot = loadPlugins(deps.pluginsDir);
    return c.json({ reloaded: true, count: snapshot.plugins.length });
  });

  return app;
}
