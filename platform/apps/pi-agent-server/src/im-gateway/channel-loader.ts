/**
 * channel-loader — reads `channels/manifest.json`, dynamically imports each
 * listed channel package, and calls `register(host)`.
 *
 * Path resolution: uses `import.meta.url` to find the manifest relative to
 * the compiled bundle — NOT `process.cwd()` (which breaks under tsx / daemon).
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ChannelPackage } from '@pi-agent-platform/channel-types';
import type { ChannelHost } from '@pi-agent-platform/channel-types';
import { logger } from './logger.js';

interface Manifest {
  channels: string[];
}

async function findManifest(): Promise<string> {
  // Packaged mode (started by `pi-server` CLI): manifest lives next to the bundled channels.
  if (process.env.PI_SERVER_CLI && process.env.CHANNELS_DIR) {
    return path.join(process.env.CHANNELS_DIR, 'manifest.json');
  }
  // Dev mode: probe well-known relative locations.
  const candidates = [
    path.resolve(process.cwd(), 'channels/manifest.json'),
    path.resolve(process.cwd(), '../channels/manifest.json'),
    path.resolve(process.cwd(), '../../channels/manifest.json'),
    path.resolve(process.cwd(), '../../../channels/manifest.json'),
    path.resolve(fileURLToPath(import.meta.url), '../../../../../../channels/manifest.json'),
    path.resolve(fileURLToPath(import.meta.url), '../../../../../channels/manifest.json'),
    path.resolve(fileURLToPath(import.meta.url), '../../../../channels/manifest.json'),
    path.resolve(fileURLToPath(import.meta.url), '../../../channels/manifest.json'),
    path.resolve(fileURLToPath(import.meta.url), '../../channels/manifest.json'),
  ];
  for (const c of candidates) {
    try {
      await readFile(c, 'utf8');
      return c;
    } catch {
      // not found, try next
    }
  }
  throw new Error(`manifest.json not found. Tried: ${candidates.join(', ')}`);
}

/**
 * Load all channels declared in manifest.json.
 * @returns list of `{ type, packagePath }` for each loaded channel.
 */
export async function loadChannels(host: ChannelHost): Promise<Array<{ type: string; packagePath: string }>> {
  const manifestPath = await findManifest();
  logger.info({ manifestPath }, 'loading channel manifest');
  const raw = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw) as Manifest;
  if (!manifest || !Array.isArray(manifest.channels)) {
    throw new Error(`Invalid manifest.json: missing 'channels' array`);
  }
  const channelsDir = path.dirname(manifestPath);
  const loaded: Array<{ type: string; packagePath: string }> = [];
  // Packaged mode: bundled channel dist (already compiled). Dev mode: live .ts source under tsx.
  const channelEntrySubpath = process.env.PI_SERVER_CLI === '1' ? 'dist/index.js' : 'src/index.ts';
  for (const channelName of manifest.channels) {
    const packagePath = path.resolve(channelsDir, channelName, channelEntrySubpath);
    logger.info({ channelName, packagePath, channelsDir, channelEntrySubpath }, 'attempting to load channel');
    try {
      // Dynamic import — convert absolute path to file:// URL (Windows requires this).
      // Cache-bust per restart by appending a query string (no-op semantics).
      const fileUrl = `${pathToFileURL(packagePath).href}?t=${Date.now()}`;
      logger.info({ fileUrl }, 'importing channel module');
      const mod = (await import(fileUrl)) as { default?: ChannelPackage };
        const pkg: ChannelPackage | undefined = mod.default ?? (mod as unknown as ChannelPackage);
        if (!pkg || typeof pkg.register !== 'function') {
          logger.warn({ channelName, modKeys: Object.keys(mod) }, 'channel package missing default export with register()');
          continue;
        }
        await pkg.register(host);
        loaded.push({ type: pkg.type, packagePath });
        logger.info({ channelName, type: pkg.type }, 'channel package loaded');
      } catch (err) {
        logger.error({ err: String(err), channelName, packagePath, stack: (err as Error).stack }, 'channel package load failed');
        // Don't fail the whole server — missing/breaking one channel shouldn't kill the others.
      }
  }
  return loaded;
}