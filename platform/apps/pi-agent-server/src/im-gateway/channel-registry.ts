/**
 * channel-registry — central map of running channels: `channelId → RegisteredChannel`.
 *
 * Re-exports from `channels/shared/channel-registry.ts` so that the server
 * process and any channel package it loads (`channels/channel-qq/...`,
 * `channels/channel-wechat/...`) share the **same in-memory Map**.
 *
 * All adapter instances live in this shared map. The registry also tracks
 * status changes and serves them to the health endpoint + admin UI.
 *
 * This file previously held its own implementation; it was collapsed to a
 * re-export as part of the `cli-packaging` change so packaged builds (which
 * have no `@pi-agent-platform/...` workspace alias) resolve cleanly.
 */

// Channel-side uses globalThis to share state; we mirror that here so both
// ends write to the same Map at runtime.
import type { ChannelId, ChannelStatusSnapshot, ChannelType } from '@pi-agent-platform/channel-types';
import type { RegisteredChannel } from './types.js';
import { logger } from './logger.js';

interface RegistryState {
  channels: Map<ChannelId, RegisteredChannel>;
  adaptersByType: Map<ChannelType, Set<RegisteredChannel>>;
}

const STATE_KEY = '__pi_agent_platform_channel_registry__';
const g = globalThis as unknown as { [STATE_KEY]?: RegistryState };
if (!g[STATE_KEY]) {
  g[STATE_KEY] = {
    channels: new Map(),
    adaptersByType: new Map(),
  };
}
const state: RegistryState = g[STATE_KEY]!;

/** Register a channel + adapter. */
export function registerChannel(channel: RegisteredChannel): void {
  state.channels.set(channel.channelId, channel);
  let set = state.adaptersByType.get(channel.channelType);
  if (!set) {
    set = new Set();
    state.adaptersByType.set(channel.channelType, set);
  }
  set.add(channel);
  logger.info({ channelId: channel.channelId, channelType: channel.channelType }, 'channel registered');
}

/** Unregister (called when channel is stopped or deleted). */
export function unregisterChannel(channelId: ChannelId): RegisteredChannel | undefined {
  const rc = state.channels.get(channelId);
  if (!rc) return undefined;
  state.channels.delete(channelId);
  state.adaptersByType.get(rc.channelType)?.delete(rc);
  logger.info({ channelId, channelType: rc.channelType }, 'channel unregistered');
  return rc;
}

export function getChannel(channelId: ChannelId): RegisteredChannel | undefined {
  return state.channels.get(channelId);
}

export function listChannels(): RegisteredChannel[] {
  return Array.from(state.channels.values());
}

export function listChannelsByType(channelType: ChannelType): RegisteredChannel[] {
  return Array.from(state.adaptersByType.get(channelType) ?? []);
}

export function setStatus(channelId: ChannelId, status: ChannelStatusSnapshot): void {
  const rc = state.channels.get(channelId);
  if (!rc) return;
  rc.status = status;
}

/** Clear all (server shutdown). */
export function clearAll(): void {
  for (const rc of state.channels.values()) {
    const adapter = rc.adapter as { stop?: () => Promise<unknown> } | undefined;
    adapter?.stop?.().catch((err: unknown) => {
      logger.warn({ err: String(err), channelId: rc.channelId }, 'stop adapter on shutdown failed');
    });
  }
  state.channels.clear();
  state.adaptersByType.clear();
}

export function size(): number {
  return state.channels.size;
}