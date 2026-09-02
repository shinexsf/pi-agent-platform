/**
 * Type stub for the plain-JS `channel-registry.js` so TypeScript code in
 * channel packages can import it without `noImplicitAny` errors.
 */

import type { ChannelConfig, ChannelId, ChannelStatusSnapshot, ChannelType } from '@pi-agent-platform/channel-types';

export interface RegisteredChannel {
  channelId: ChannelId;
  channelType: ChannelType;
  config: ChannelConfig;
  adapter?: unknown;
  status?: ChannelStatusSnapshot;
  lastError?: string;
  connectedAt?: number;
}

export function registerChannel(channel: RegisteredChannel): void;
export function unregisterChannel(channelId: ChannelId): RegisteredChannel | undefined;
export function getChannel(channelId: ChannelId): RegisteredChannel | undefined;
export function listChannelsByType(channelType: ChannelType): RegisteredChannel[];
export function snapshot(): ChannelStatusSnapshot[];
export function size(): number;
export function clearAll(): void;