/**
 * Typed API wrappers for /api/im/qq/*.
 */
import type { ChannelAdminHost } from '@pi-agent-platform/channel-types';

export interface QqChannel {
  id: string;
  type: 'qq';
  displayName: string;
  enabled: boolean;
  defaultAgentId?: string;
  appId: string;
  appSecret: string;
  autoReconnect?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export function createQqApi(host: ChannelAdminHost) {
  return {
    list: async (): Promise<QqChannel[]> => {
      const res = (await host.apiFetch('GET', '/channels')) as { channels: QqChannel[] };
      return res.channels;
    },
    create: async (input: { displayName: string; defaultAgentId: string; appId: string; appSecret: string; autoReconnect?: boolean }): Promise<QqChannel> => {
      return (await host.apiFetch('POST', '/channels', input)) as QqChannel;
    },
    get: async (id: string): Promise<QqChannel> => {
      return (await host.apiFetch('GET', `/channels/${id}`)) as QqChannel;
    },
    update: async (id: string, patch: Partial<QqChannel>): Promise<QqChannel> => {
      return (await host.apiFetch('PATCH', `/channels/${id}`, patch)) as QqChannel;
    },
    remove: async (id: string): Promise<void> => {
      await host.apiFetch('DELETE', `/channels/${id}`);
    },
    start: async (id: string): Promise<{ ok: boolean; status: string }> => {
      return (await host.apiFetch('POST', `/channels/${id}/start`)) as { ok: boolean; status: string };
    },
    stop: async (id: string): Promise<{ ok: boolean }> => {
      return (await host.apiFetch('POST', `/channels/${id}/stop`)) as { ok: boolean };
    },
  };
}