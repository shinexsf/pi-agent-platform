/**
 * QQ admin page — exported as ChannelAdminPage.
 */
import type { ChannelAdminPage } from '@pi-agent-platform/channel-types';

const QqChannelAdminPage: ChannelAdminPage = {
  channelType: 'qq',
  displayName: 'QQ Channel',
  component: () => import('./QqChannelsPage.vue'),
};

export default QqChannelAdminPage;
