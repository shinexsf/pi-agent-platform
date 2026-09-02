/**
 * Channel-shared registry (plain JS — no TS, no workspace-internal imports).
 *
 * Mirror of `apps/pi-agent-server/src/im-gateway/channel-registry.ts`. Exists
 * here so channels don't need to import from `@pi-agent-platform/server/...`
 * (workspace-internal, unavailable in the packaged npm tarball).
 *
 * Both copies (server + channel) share the same in-memory Map via
 * `globalThis`. Same-process, so a single Map is correct.
 *
 * Keep this in sync with the upstream registry if shape changes.
 */

import { logger } from './logger.js';

const STATE_KEY = '__pi_agent_platform_channel_registry__';
const g = globalThis;

if (!g[STATE_KEY]) {
  g[STATE_KEY] = {
    channels: new Map(),
    adaptersByType: new Map(),
  };
}

const state = g[STATE_KEY];

/**
 * @param {{ channelId: string, channelType: string, [k: string]: unknown }} channel
 */
export function registerChannel(channel) {
  state.channels.set(channel.channelId, channel);
  let set = state.adaptersByType.get(channel.channelType);
  if (!set) {
    set = new Set();
    state.adaptersByType.set(channel.channelType, set);
  }
  set.add(channel);
  logger.info(
    { channelId: channel.channelId, channelType: channel.channelType },
    'channel registered',
  );
}

/**
 * @param {string} channelId
 */
export function unregisterChannel(channelId) {
  const rc = state.channels.get(channelId);
  if (!rc) return undefined;
  state.channels.delete(channelId);
  state.adaptersByType.get(rc.channelType)?.delete(rc);
  logger.info({ channelId, channelType: rc.channelType }, 'channel unregistered');
  return rc;
}

/**
 * @param {string} channelId
 */
export function getChannel(channelId) {
  return state.channels.get(channelId);
}

/**
 * @param {string} channelType
 */
export function listChannelsByType(channelType) {
  return Array.from(state.adaptersByType.get(channelType) ?? []);
}

export function snapshot() {
  return Array.from(state.channels.values()).map((rc) => ({
    channelId: rc.channelId,
    channelType: rc.channelType,
    status: rc.status,
    lastError: rc.lastError,
    connectedAt: rc.connectedAt,
  }));
}

export function size() {
  return state.channels.size;
}

export function clearAll() {
  state.channels.clear();
  state.adaptersByType.clear();
}