/**
 * WeChat admin page — exported as ChannelAdminPage.
 *
 * Web host picks this up via import.meta.glob matching each channel's admin entry.
 */
import type { ChannelAdminPage } from '@pi-agent-platform/channel-types';

const WechatChannelAdminPage: ChannelAdminPage = {
  channelType: 'wechat',
  displayName: 'WeChat Channel',
  navItem: {
    path: '/im/wechat',
    label: 'WeChat Channel',
    order: 40,
  },
  component: () => import('./WechatChannelsPage.vue'),
};

export default WechatChannelAdminPage;