/**
 * `GET /api/plugins` — 平台插件目录视图（change: plugin-mechanism / platform-plugins-catalog）。
 *
 * **只读**：安装/卸载/启停只能走 `pi-server plugin`，这里刻意不提供任何写端点。
 * 目录视图同样只读：不写 `registry.json`、不改目录；详情里的磁盘探测每次现读。
 */

import { Hono } from 'hono';
import type { GetPluginDetailResponse, ListPluginsResponse } from '@pi-agent-platform/api-types';
import {
  describePluginDetail,
  facetSupportMap,
  getPluginSnapshot,
  loadPlugins,
  toPluginEntryDTO,
} from '../services/plugins.js';
export interface PluginsRouterDeps {
  pluginsDir: string;
  /** pi 的 agent 目录（判定依赖安装时读它的 `settings.json` 与 `npm/node_modules`）。 */
  agentDir: string;
}

export function createPluginsRouter(deps: PluginsRouterDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const snapshot = getPluginSnapshot(deps.pluginsDir);
    const body: ListPluginsResponse = {
      plugins: snapshot.plugins.map(toPluginEntryDTO),
      disabledByFlag: snapshot.disabledByFlag,
      pluginsDir: deps.pluginsDir,
      facetSupport: facetSupportMap(),
    };
    return c.json(body);
  });

  // 调试：强制重读（不重启 server）
  app.get('/reload', (c) => {
    const snapshot = loadPlugins(deps.pluginsDir);
    return c.json({ reloaded: true, count: snapshot.plugins.length });
  });

  // 单插件详情：声明 + 入口探测 + 依赖安装状态
  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const detail = describePluginDetail(deps.pluginsDir, id, deps.agentDir);
    if (!detail) return c.json({ error: 'plugin not found' }, 404);
    const body: GetPluginDetailResponse = { detail };
    return c.json(body);
  });

  return app;
}
