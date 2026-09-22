/**
 * WeChat channel package entry. Imported by server's channel-loader.
 *
 * Calls register(host) once at startup:
 *   1. Declare channels_wechat table migration
 *   2. Seed existing channel configs from DB into host memory (so they
 *      survive server restarts)
 *   3. Mount /api/im/wechat/* routes
 *
 * NOTE: does NOT auto-start adapters. Start happens via POST /channels/:id/start.
 */
import type { ChannelHost, ChannelPackage } from '@pi-agent-platform/channel-types';
import { createWechatRoutes } from './routes.js';
import { MIGRATION_SQL, SCHEMA_HINTS } from './schema.js';
import { logger } from '../../shared/logger.js';

const WechatChannelPackage: ChannelPackage = {
  type: 'wechat',
  displayName: 'WeChat (iLink ClawBot)',
  schemaHints: SCHEMA_HINTS,

  async register(host: ChannelHost): Promise<void> {
    // 1. Run migration
    host.executeMigration('wechat_channels_v1', MIGRATION_SQL);

    // 2. Seed existing channel configs from DB into host memory.
    // Without this, channels created in prior server sessions are invisible
    // to /api/im/<type>/* routes (which look up by id from host memory).
    try {
      const rows = host.query(
        'SELECT id, display_name, enabled, default_agent_id, current_session_id, storage_dir, auto_reconnect, created_at, updated_at FROM channels_wechat'
      ) as Array<{
        id: string;
        display_name: string;
        enabled: number;
        default_agent_id: string | null;
        current_session_id: string | null;
        storage_dir: string;
        auto_reconnect: number;
        created_at: number;
        updated_at: number;
      }>;
      let seeded = 0;
      for (const r of rows) {
        host.createChannelConfig({
          id: r.id,
          type: 'wechat',
          displayName: r.display_name,
          enabled: r.enabled === 1,
          defaultAgentId: r.default_agent_id ?? undefined,
          currentSessionId: r.current_session_id ?? undefined,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          extra: {
            storageDir: r.storage_dir,
            autoReconnect: r.auto_reconnect === 1,
          },
        });
        // Rebuild session-channel-map for sessions that survived restart
        if (r.current_session_id) {
          host.seedSessionFromConfig(r.id, r.current_session_id, undefined, r.default_agent_id ?? undefined);
        }
        seeded++;
      }
      if (seeded > 0) {
        // eslint-disable-next-line no-console
        logger.info({ seeded }, 'channel-wechat: seeded channels from DB');
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      logger.warn({ err: String(err) }, 'failed to seed from DB');
    }

    // 3. Mount routes
    const { router } = createWechatRoutes(host);
    host.registerRoutes('/api/im/wechat', router);
  },
};

export default WechatChannelPackage;