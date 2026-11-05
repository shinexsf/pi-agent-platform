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
import { config } from '../config.js';
import { extractExtensionNames, readSettings } from '../services/extension-utils.js';
import { getPluginSnapshot, resolveSessionPlugins, toPluginEntryDTO } from '../services/plugins.js';
import { listSessionExtensions } from '../services/plugin-extensions.js';
import type { AgentRepo } from '../repos/agent.repo.js';
import type { SessionRepo } from '../repos/session.repo.js';

const logger = childLogger('plugin-emit');

export interface SessionPluginsRouterDeps {
  workerPool: WorkerPool;
  agentRepo: AgentRepo;
  sessionRepo: SessionRepo;
}

export function createSessionPluginsRouter(deps: SessionPluginsRouterDeps): Hono {
  const app = new Hono();

  /**
   * `GET /api/sessions/:id/plugins` —— 该会话**会话级闸门**的解析结果。
   *
   * 为什么需要它：`GET /api/plugins` 是全局视图（配置页用），跟"这个会话到底加载了哪些插件"无关。
   * web 槽位必须按会话渲染，否则 agent 没启用插件的会话也会冒出图标/面板（spec: plugin-facets 会话级闸门）。
   *
   * 占位会话（库里还没有行、agent 未定）返回全局可用集合：此时还谈不上闸门。
   */
  app.get('/:id/plugins', async (c) => {
    const sessionId = c.req.param('id');
    const snapshot = getPluginSnapshot(config.pluginsDir);
    if (snapshot.disabledByFlag) {
      return c.json({ disabledByFlag: true, plugins: [] });
    }

    const session = deps.sessionRepo.get(sessionId);
    const agent = session?.agentId ? deps.agentRepo.get(session.agentId) : null;
    if (!session) {
      return c.json({
        disabledByFlag: false,
        placeholder: true,
        plugins: snapshot.plugins.filter((p) => p.status === 'active').map(toPluginEntryDTO),
      });
    }

    try {
      const settings = await readSettings(config.agentDir);
      const resolved = resolveSessionPlugins({
        snapshot,
        agentExtensions: agent?.config?.extensions ?? [],
        installedPiExtensions: extractExtensionNames(settings),
      });
      const byId = new Map(snapshot.plugins.map((p) => [p.entry.id, p]));
      return c.json({
        disabledByFlag: false,
        placeholder: false,
        plugins: resolved
          .filter((r) => r.enabled)
          .map((r) => {
            const loaded = byId.get(r.id);
            return loaded ? toPluginEntryDTO(loaded) : { id: r.id, enabled: true, facets: {} };
          }),
      });
    } catch (err) {
      logger.warn({ sessionId, err: String(err) }, 'session plugin resolution failed');
      return c.json({ disabledByFlag: false, plugins: [] });
    }
  });

  /**
   * `GET /api/sessions/:id/extensions` —— 该会话生效的 rail 槽位与工具卡片。
   *
   * 与 `/:id/plugins` 的分工：那个只说"哪些插件对这个会话启用"，这个说"启用的插件贡献了什么界面"。
   */
  app.get('/:id/extensions', async (c) => {
    const sessionId = c.req.param('id');
    const snapshot = getPluginSnapshot(config.pluginsDir);
    if (snapshot.disabledByFlag) {
      return c.json({ surfaces: [], toolCards: [], disabled: {}, disabledByFlag: true });
    }

    const session = deps.sessionRepo.get(sessionId);
    const agent = session?.agentId ? deps.agentRepo.get(session.agentId) : null;
    if (!session) {
      const all = new Set(snapshot.plugins.filter((p) => p.status === 'active').map((p) => p.entry.id));
      const { surfaces, toolCards } = listSessionExtensions(all);
      return c.json({
        surfaces: surfaces.map(({ pluginId, def }) => ({ pluginId, ...def })),
        toolCards: toolCards.map(({ pluginId, def }) => ({ pluginId, ...def })),
        disabled: {},
        disabledByFlag: false,
        placeholder: true,
      });
    }

    try {
      const settings = await readSettings(config.agentDir);
      const resolved = resolveSessionPlugins({
        snapshot,
        agentExtensions: agent?.config?.extensions ?? [],
        installedPiExtensions: extractExtensionNames(settings),
      });
      const enabled = new Set(resolved.filter((r) => r.enabled).map((r) => r.id));
      const disabled: Record<string, string> = {};
      for (const r of resolved) if (!r.enabled) disabled[r.id] = r.reason ?? '未启用';
      const { surfaces, toolCards } = listSessionExtensions(enabled);
      return c.json({
        surfaces: surfaces.map(({ pluginId, def }) => ({ pluginId, ...def })),
        toolCards: toolCards.map(({ pluginId, def }) => ({ pluginId, ...def })),
        disabled,
        disabledByFlag: false,
        placeholder: false,
      });
    } catch (err) {
      logger.warn({ sessionId, err: String(err) }, 'session extension resolution failed');
      return c.json({ surfaces: [], toolCards: [], disabled: {}, disabledByFlag: false });
    }
  });

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
