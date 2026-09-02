/**
 * QQ channel package entry.
 *
 * MVP: 7 routes, p2p only. Group chat → fast → server routing layer.
 */
import type { ChannelHost, ChannelPackage } from '@pi-agent-platform/channel-types';
import { createQqRoutes } from './routes.js';
import { logger } from '../../shared/logger.js';
import { MIGRATION_SQL, SCHEMA_HINTS } from './schema.js';

const QqChannelPackage: ChannelPackage = {
  type: 'qq',
  displayName: 'QQ Bot (p2p MVP)',
  schemaHints: SCHEMA_HINTS,

  async register(host: ChannelHost): Promise<void> {
    host.executeMigration('qq_channels_v1', MIGRATION_SQL);

    // Seed existing channel configs from DB so they survive restarts.
    try {
      const rows = host.query(
        'SELECT id, display_name, enabled, default_agent_id, current_session_id, app_id, app_secret, auto_reconnect, created_at, updated_at FROM channels_qq'
      ) as Array<{
        id: string;
        display_name: string;
        enabled: number;
        default_agent_id: string | null;
        current_session_id: string | null;
        app_id: string;
        app_secret: string;
        auto_reconnect: number;
        created_at: number;
        updated_at: number;
      }>;
      let seeded = 0;
      for (const r of rows) {
        host.createChannelConfig({
          id: r.id,
          type: 'qq',
          displayName: r.display_name,
          enabled: r.enabled === 1,
          defaultAgentId: r.default_agent_id ?? undefined,
          currentSessionId: r.current_session_id ?? undefined,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          extra: {
            appId: r.app_id,
            appSecret: r.app_secret,
            autoReconnect: r.auto_reconnect === 1,
          },
        });
        seeded++;
      }
      if (seeded > 0) {
        // eslint-disable-next-line no-console
        logger.info({ seeded }, "channel-qq: seeded channels from DB");
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[channel-qq] failed to seed from DB:', String(err));
    }

    const { router } = createQqRoutes(host);
    host.registerRoutes('/api/im/qq', router);
  },
};

export default QqChannelPackage;