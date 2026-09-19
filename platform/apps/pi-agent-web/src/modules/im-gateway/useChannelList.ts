/**
 * useChannelList — 共享的渠道清单（module-level 缓存 + 单次在途请求）。
 *
 * 为什么需要：抽屉二级菜单与 `views/im/ChannelsView.vue` 都要渠道列表，
 * 而 `loadChannelManifest()` 是一次网络请求。共享缓存避免重复请求，
 * 也保证两处渲染同一份数据。
 */
import { ref, type Ref } from 'vue';
import { channelAdminRegistry, loadChannelManifest, type ChannelAdminPage } from './index';

let cached: ChannelAdminPage[] | null = null;
let inflight: Promise<ChannelAdminPage[]> | null = null;

const sharedChannels = ref<ChannelAdminPage[]>([]);
const sharedReady = ref(false);

function resolveChannels(): Promise<ChannelAdminPage[]> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = loadChannelManifest()
      .then((list) => {
        // manifest 返回空时用 registry 兜底（与改造前 ChannelsView 的行为一致）
        cached = list.length > 0 ? list : channelAdminRegistry;
        return cached;
      })
      .catch((err) => {
        console.error('[im-gateway] failed to load channel manifest:', err);
        cached = channelAdminRegistry;
        return cached;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export function useChannelList(): {
  channels: Ref<ChannelAdminPage[]>;
  ready: Ref<boolean>;
} {
  if (!sharedReady.value) {
    void resolveChannels().then((list) => {
      sharedChannels.value = list;
      sharedReady.value = true;
    });
  }
  return { channels: sharedChannels, ready: sharedReady };
}

/** 默认选中第一个渠道（列表为空时返回空串）。 */
export function defaultChannelType(list: ChannelAdminPage[]): string {
  return list[0]?.channelType ?? '';
}
