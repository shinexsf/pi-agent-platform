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
import type { WorkerPool } from '@pi-agent-platform/core';
import { childLogger } from '@pi-agent-platform/core';
import { config } from '../config.js';
import { sessionRegistry } from '@pi-agent-platform/core';
import { extractExtensionNames, readSettings } from '@pi-agent-platform/core';
import { getPluginSnapshot, resolveSessionPlugins, toPluginEntryDTO } from '@pi-agent-platform/core';
import { listSessionExtensions, pluginWebRevisions } from '@pi-agent-platform/core';
import type { AgentRepo } from '@pi-agent-platform/core';
import type { SessionRepo } from '@pi-agent-platform/core';

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

    const row = deps.sessionRepo.get(sessionId);
    const agent = row?.agentId ? deps.agentRepo.get(row.agentId) : null;
    if (!row) {
      return c.json({
        disabledByFlag: false,
        placeholder: true,
        plugins: snapshot.plugins.filter((p) => p.status === 'active').map(toPluginEntryDTO),
      });
    }

    try {
      // 与会话 worker 实际装载**同源**：优先用 spawn 时下发的那份快照；
      // 只有在没有存活会话对象（worker 已回收）时才回落到会话行的 config 重新推导。
      // 绝不使用 agent 的当前 extensions —— 那是"现在"的配置，会话是"当时"的快照。
      const live = sessionRegistry().get(sessionId);
      const installed = extractExtensionNames(await readSettings(config.agentDir));
      const resolved = live
        ? live.plugins
        : resolveSessionPlugins({
            snapshot,
            // 启用列表与会话 worker 同源：会话行是 spawn 时的快照，没有该字段才回落到 agent。
            // 漏传的后果是 **全部插件被判"该 agent 未启用"**（见 `/extensions` 同款注释）。
            enabledPlugins: row.config?.plugins ?? agent?.config?.plugins ?? [],
            agentExtensions: row.config?.extensions ?? agent?.config?.extensions ?? [],
            installedPiExtensions: installed,
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
        revs: pluginWebRevisions(config.pluginsDir),
      });
    }

    try {
      const settings = await readSettings(config.agentDir);
      // 优先用存活会话对象里那份 spawn 时下发的快照（与 worker 实际装载同源）；
      // 回落时才按会话行（没有该字段再用 agent）重新推导。
      const live = sessionRegistry().get(sessionId);
      const resolved = live
        ? live.plugins
        : resolveSessionPlugins({
            snapshot,
            // ⚠️ 别漏这个参数：`resolveSessionPlugins` 的 `enabledPlugins` 缺省是空集合，
            // 漏传会让**所有**插件都被判成"该 agent 未启用此插件"，
            // 于是会话作用域的 rail 槽位 / 工具卡片永远渲染不出来（2026-11-20 实测踩到）。
            enabledPlugins: session.config?.plugins ?? agent?.config?.plugins ?? [],
            agentExtensions: session.config?.extensions ?? agent?.config?.extensions ?? [],
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
        revs: pluginWebRevisions(config.pluginsDir),
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
    // 下行只走插件自己注册的方法：`<id>.emit`。没有这个方法（插件未注册 /
    // 插件被禁用）会得到 `unknown method`，而不是"静默吞掉"。
    try {
      await deps.workerPool.call(sessionId, `${pluginId}.emit`, [
        { name: body.name, data: body.data ?? null },
      ]);
      return c.json({ handled: true });
    } catch (err) {
      logger.warn({ sessionId, pluginId, err: String(err) }, 'plugin emit could not reach worker');
      return c.json({ handled: false });
    }
  });

  return app;
}
