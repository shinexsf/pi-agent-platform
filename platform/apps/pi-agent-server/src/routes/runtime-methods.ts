/**
 * IPC 方法清单（诊断用，只读）。
 *
 * `GET /api/runtime/methods` → `{ reverse: [...], workers: [{ sessionId, ready, forward }] }`
 *
 * 这是"注册表是唯一分发依据"的可观测面：改名、漏注册、插件被禁用，都能在这里
 * 直接看出来，而不必等某次调用失败。反向表来自 master 自己；正向表来自每个
 * worker 在 `ready` 握手中交付的摘要（纯数据，不含 handler）。
 */

import { Hono } from 'hono';
import type { WorkerPool } from '../worker-pool.js';

export function createRuntimeMethodsRouter(workerPool: WorkerPool): Hono {
  const app = new Hono();

  app.get('/', (c) => c.json(workerPool.methodInventory()));

  return app;
}
