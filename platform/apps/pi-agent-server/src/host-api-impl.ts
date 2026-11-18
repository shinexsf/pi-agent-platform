/**
 * 宿主 API 的实现（入口侧）。
 *
 * 内核只声明六个面的**形状**（`packages/core/src/host-api.ts`），实现放在组合根 ——
 * 因为"暴露到什么程度"是入口的决定（桌面端可能不给 `db.executeMigration`）。
 *
 * 这是插件与内核之间唯一应该被依赖的缝：插件拿 `HostApi`，不 import 内核内部模块。
 */

import type { HostApi } from '@pi-agent-platform/core';
import { sessionRegistry } from '@pi-agent-platform/core';
import { childLogger } from '@pi-agent-platform/core';
import type Database from 'better-sqlite3';
import type { SessionRepo, WorkerPool } from '@pi-agent-platform/core';

const logger = childLogger('host-api');

export interface HostApiDeps {
  raw: Database.Database;
  sessionRepo: SessionRepo;
  workerPool: WorkerPool;
}

export function createHostApi(deps: HostApiDeps): HostApi {
  return {
    db: {
      executeMigration(name, ddl) {
        deps.raw.exec(ddl);
        logger.info({ name }, 'module migration executed');
      },
    },

    sessions: {
      hasRow: (sessionId) => Boolean(deps.sessionRepo.get(sessionId)),
      subscribe: (sessionId, listener, onDispose) =>
        sessionRegistry().track(sessionId).subscribe(listener, onDispose),
    },

    lifecycle: {
      onSessionCreated: (hook) => sessionRegistry().onSessionCreated(hook),
      onSessionDisposed: (hook) => sessionRegistry().onSessionDisposed(hook),
    },

    outbound: {
      registerService(source, kind, handlers) {
        deps.workerPool.registerService(source, { kind }, handlers);
      },
    },

    events: {
      // 与 SSE 侧同一上限：事件是增量，不是通道。
      maxPayloadBytes: 64 * 1024,
    },

    web: {
      // 入口自己决定怎么托管；这里给出平台约定的同源前缀。
      assetBasePath: (pluginId) => `/plugins/${pluginId}/web`,
    },
  };
}
