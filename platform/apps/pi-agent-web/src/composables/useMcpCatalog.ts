/**
 * useMcpCatalog — 平台 MCP 目录（`~/.pi/server/mcp.json`）的前端读取（change: platform-mcp-catalog）。
 *
 * 目录是所有 agent 共享的 server 定义源，DB 里只存 server 名字。三个配置面（agent 编辑、
 * session 详情编辑、模板编辑器）共用同一份数据，所以这里做了模块级缓存：一次 fetch 到处用，
 * 失败也不抛（只是没有可选 server，界面按「目录为空」渲染）。
 */
import { ref, type Ref } from 'vue';
import type { McpCatalogResponseDTO, McpCatalogServerDTO } from '@pi-agent-platform/api-types';

export interface McpCatalogApi {
  servers: Ref<McpCatalogServerDTO[]>;
  /** 目录里逐条的解析错误（一个坏条目不掩盖其它 server）。 */
  errors: Ref<string[]>;
  /** 同时被 pi 自己的 mcp.json 定义的 server 名 —— pi 优先，平台开关对它们无效。 */
  conflicts: Ref<string[]>;
  path: Ref<string>;
  loading: Ref<boolean>;
  load: () => Promise<void>;
}

let modulePromise: Promise<McpCatalogResponseDTO | undefined> | undefined;

async function fetchCatalog(): Promise<McpCatalogResponseDTO | undefined> {
  modulePromise ??= (async () => {
    try {
      const res = await fetch('/api/config/mcp-servers');
      if (!res.ok) return undefined;
      return (await res.json()) as McpCatalogResponseDTO;
    } catch {
      return undefined;
    }
  })();
  return modulePromise;
}

/** Drop the cached fetch (after the user edits the catalog file by hand). */
export function invalidateMcpCatalog(): void {
  modulePromise = undefined;
}

export function useMcpCatalog(): McpCatalogApi {
  const servers = ref<McpCatalogServerDTO[]>([]);
  const errors = ref<string[]>([]);
  const conflicts = ref<string[]>([]);
  const path = ref('');
  const loading = ref(false);

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const data = await fetchCatalog();
      servers.value = data?.servers ?? [];
      errors.value = data?.errors ?? [];
      conflicts.value = data?.conflicts ?? [];
      path.value = data?.path ?? '';
    } finally {
      loading.value = false;
    }
  }

  return { servers, errors, conflicts, path, loading, load };
}
