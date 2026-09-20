/**
 * WeChat admin page — exported as ChannelAdminPage.
 *
 * Web host picks this up via import.meta.glob matching each channel's admin entry.
 */
import type { ChannelAdminPage } from '@pi-agent-platform/channel-types';

const WechatChannelAdminPage: ChannelAdminPage = {
  channelType: 'wechat',
  displayName: 'WeChat',
  component: () => import('./WechatChannelsPage.vue'),
};

export default WechatChannelAdminPage;
