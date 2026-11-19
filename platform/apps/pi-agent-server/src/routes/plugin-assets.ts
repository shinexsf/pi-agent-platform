/**
 * 插件 web 资源托管（change: plugin-mechanism 6.1）。
 *
 * `GET /plugins/<pluginId>/web/<file>`
 *
 * 插件目录不一定在 `pluginsDir` 下（`pi-server plugin add <local dir>` 只把**源目录**
 * 记进 registry），所以这里按 registry 解析真实目录，而不是把 pluginsDir 当根。
 *
 * 安全边界：
 * - 只允许读插件目录下 `web/` 里的文件（拼接后必须仍在 web 根内）
 * - 只放行少数静态类型；不执行、不转换、不代理任何远程内容
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { getPluginSnapshot } from '@pi-agent-platform/core';
import { childLogger } from '@pi-agent-platform/core';

const logger = childLogger('plugin-assets');

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export interface PluginAssetsRouterDeps {
  pluginsDir: string;
}

export function createPluginAssetsRouter(deps: PluginAssetsRouterDeps): Hono {
  const app = new Hono();

  app.get('/*', (c) => {
    const rest = c.req.path.replace(/^\/plugins\/?/, '');
    const marker = '/web/';
    const at = rest.lastIndexOf(marker);
    if (at <= 0) return c.notFound();
    const pluginId = decodeURIComponent(rest.slice(0, at));
    const relFile = decodeURIComponent(rest.slice(at + marker.length));
    if (!pluginId || !relFile || relFile.includes('..') || relFile.startsWith('/')) {
      return c.text('bad path', 400);
    }

    // 目录解析必须走**快照**而不是 registry：随包插件（bundled）不进 registry，
    // 只查 registry 会让它们的 web 资源 404 —— 而页面注册是成功的，症状是"页面白着"。
    const plugin = getPluginSnapshot(deps.pluginsDir).plugins.find((p) => p.entry.id === pluginId);
    if (!plugin) return c.notFound();

    const webRoot = path.join(plugin.entry.dir, 'web');
    const abs = path.resolve(webRoot, relFile);
    if (!abs.startsWith(path.resolve(webRoot) + path.sep)) {
      return c.text('bad path', 400);
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) return c.notFound();

    const ext = path.extname(abs).toLowerCase();
    const type = CONTENT_TYPES[ext];
    if (!type) {
      logger.warn({ pluginId, relFile }, 'plugin asset type not allowed');
      return c.text('unsupported type', 415);
    }

    // 插件资源随插件版本变化，用 no-cache 让重装后立刻生效（体积很小，不值得 ETag 复杂度）
    c.header('content-type', type);
    c.header('cache-control', 'no-cache');
    return c.body(readFileSync(abs));
  });

  return app;
}
