/**
 * channel-registry — central map of running channels: `channelId → RegisteredChannel`.
 *
 * All adapter instances live here. The registry also tracks status changes and
 * serves them to the health endpoint + admin UI.
 */

import type { ChannelId, ChannelStatusSnapshot, ChannelType } from '@pi-agent-platform/channel-types';
import type { RegisteredChannel } from './types.js';
import { logger } from './logger.js';

const channels = new Map<ChannelId, RegisteredChannel>();
const adaptersByType = new Map<ChannelType, Set<RegisteredChannel>>();

/** Register a channel + adapter. */
export function registerChannel(channel: RegisteredChannel): void {
  channels.set(channel.channelId, channel);
  let set = adaptersByType.get(channel.channelType);
  if (!set) {
    set = new Set();
    adaptersByType.set(channel.channelType, set);
  }
  set.add(channel);
  logger.info({ channelId: channel.channelId, channelType: channel.channelType }, 'channel registered');
}

/** Unregister (called when channel is stopped or deleted). */
export function unregisterChannel(channelId: ChannelId): RegisteredChannel | undefined {
  const rc = channels.get(channelId);
  if (!rc) return undefined;
  channels.delete(channelId);
  adaptersByType.get(rc.channelType)?.delete(rc);
  logger.info({ channelId, channelType: rc.channelType }, 'channel unregistered');
  return rc;
}

export function getChannel(channelId: ChannelId): RegisteredChannel | undefined {
  return channels.get(channelId);
}

export function listChannels(): RegisteredChannel[] {
  return Array.from(channels.values());
}

export function listChannelsByType(channelType: ChannelType): RegisteredChannel[] {
  return Array.from(adaptersByType.get(channelType) ?? []);
}

export function setStatus(channelId: ChannelId, status: ChannelStatusSnapshot): void {
  const rc = channels.get(channelId);
  if (!rc) return;
  rc.status = status;
}

/** Clear all (server shutdown). */
export function clearAll(): void {
  for (const rc of channels.values()) {
    rc.adapter.stop().catch((err: unknown) => {
      logger.warn({ err: String(err), channelId: rc.channelId }, 'stop adapter on shutdown failed');
    });
  }
  channels.clear();
  adaptersByType.clear();
}

export function size(): number {
  return channels.size;
}