/**
 * IPC 方法清单（诊断用，只读）。
 *
 * `GET /api/runtime/methods` → `{ reverse: [...], workers: [{ sessionId, ready, forward }] }`
 *
 * 这是"注册表是唯一分发依据"的可观测面：改名、漏注册、插件被禁用，都能在这里
 * 直接看出来，而不必等某次调用失败。反向表来自 master 自己；正向表来自每个
 * worker 在 `ready` 握手中交付的摘要（纯数据，不含 handler）。
 *
 * `GET /api/runtime/interop` 是它的插件间孪生面：topic 目录（谁声明、谁在听、末次发布）
 * 与服务目录（谁提供了什么）。两条派发路径刻意**不合并**，只在这里并排呈现。
 */

import { Hono } from 'hono';
import type { WorkerPool } from '@pi-agent-platform/core';
import type { PluginActionsResponse, PluginInteropResponse } from '@pi-agent-platform/api-types';
import { pluginActionSnapshot, pluginInteropSnapshot } from '../host-api-impl.js';

export function createRuntimeMethodsRouter(workerPool: WorkerPool): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(workerPool.methodInventory()));

  return app;
}

/**
 * `GET /api/runtime/interop` —— 插件间目录（topic + service）。
 *
 * 与 `/api/runtime/methods` 并列而不是合并：广播与定向调用的空态语义不同，
 * 合成一个响应只会让人以为它们是一套机制。
 */
export function createInteropRouter(): Hono {
  const app = new Hono();
  app.get('/', (c) => {
    const body: PluginInteropResponse = pluginInteropSnapshot();
    return c.json(body);
  });
  return app;
}

/**
 * `GET /api/runtime/actions` —— 动作目录。
 *
 * 一条动作可能同时出现在四个面上（反向方法 / service / 工具 / HTTP 路由），
 * 这一处把这些面**按动作**并排给出：`scope` 说"谁能调"，`hasTool` / `http` 说"暴露到哪"。
 * 排查"模型为什么没有这个工具"看这里，而不是猜 pi 的注册表。
 */
export function createActionsRouter(): Hono {
  const app = new Hono();
  app.get('/', (c) => c.json({ actions: pluginActionSnapshot() } as PluginActionsResponse));
  return app;
}
