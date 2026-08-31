/**
 * Typed API wrappers for /api/im/wechat/* — used by admin UI components.
 */
import type { ChannelAdminHost } from '@pi-agent-platform/channel-types';

export interface WechatChannel {
  id: string;
  type: 'wechat';
  displayName: string;
  enabled: boolean;
  defaultAgentId?: string;
  currentSessionId?: string;
  storageDir?: string;
  autoReconnect?: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export function createWechatApi(host: ChannelAdminHost) {
  return {
    list: async (): Promise<WechatChannel[]> => {
      const res = (await host.apiFetch('GET', '/channels')) as { channels: WechatChannel[] };
      return res.channels;
    },
    create: async (input: { displayName: string; defaultAgentId: string; storageDir: string; autoReconnect?: boolean }): Promise<WechatChannel> => {
      return (await host.apiFetch('POST', '/channels', input)) as WechatChannel;
    },
    get: async (id: string): Promise<WechatChannel> => {
      return (await host.apiFetch('GET', `/channels/${id}`)) as WechatChannel;
    },
    update: async (id: string, patch: Partial<WechatChannel>): Promise<WechatChannel> => {
      return (await host.apiFetch('PATCH', `/channels/${id}`, patch)) as WechatChannel;
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