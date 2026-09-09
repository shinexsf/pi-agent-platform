/**
 * Re-export ChannelAdminPage type for web bundle + define the global
 * `useChannelAdminHost()` composable.
 *
 * Channel packages import `ChannelAdminPage` from `@pi-agent-platform/channel-types`.
 * The web host picks them up via `import.meta.glob` and pushes them into
 * `channelAdminRegistry` which is then consumed by `useChannelAdminHost()`.
 */

import { inject, provide, type InjectionKey, type App } from 'vue';
import type { ChannelAdminHost } from '@pi-agent-platform/channel-types';

export type { ChannelAdminHost, ChannelAdminPage, ToastOptions, ConfirmDialogOptions } from '@pi-agent-platform/channel-types';

export const ChannelAdminHostKey: InjectionKey<ChannelAdminHost> = Symbol('ChannelAdminHost');

/** Provide the admin host to descendants. Called once from main.ts. */
export function provideChannelAdminHost(app: App, host: ChannelAdminHost): void {
  app.provide(ChannelAdminHostKey, host);
}

/** Composable: returns the channel admin host (throws if not provided). */
export function useChannelAdminHost(): ChannelAdminHost {
  const host = inject(ChannelAdminHostKey);
  if (!host) {
    throw new Error('useChannelAdminHost must be called inside a component tree where the host is provided');
  }
  return host;
}