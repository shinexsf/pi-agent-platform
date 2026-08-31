/**
 * WeChat channel config schema.
 *
 * The schema is the source of truth for the admin UI form (auto-generated from
 * schemaHints on the ChannelPackage) and for the runtime config validation.
 */

export interface WechatChannelConfig {
  id: string;
  type: 'wechat';
  displayName: string;
  enabled: boolean;
  defaultAgentId?: string;
  currentSessionId?: string;
  /** WeChat storage dir (ClawBot data). Absolute path. */
  storageDir: string;
  /** Whether to auto-reconnect on disconnect (default true). */
  autoReconnect?: boolean;
  /** Created/updated timestamps (managed by host). */
  createdAt: number;
  updatedAt: number;
}

/** Channel package schema hints — drives the admin UI form. */
export const SCHEMA_HINTS = {
  configFields: [
    {
      key: 'displayName',
      label: 'Channel Name',
      type: 'text' as const,
      required: true,
      placeholder: 'e.g. 客服小助手',
      help: '展示在 admin 列表的显示名',
    },
    {
      key: 'storageDir',
      label: 'Storage Directory',
      type: 'path' as const,
      required: true,
      placeholder: '/data/wechat/clawbot',
      help: 'iLink ClawBot 数据目录(每个微信账号独立)',
    },
    {
      key: 'defaultAgentId',
      label: 'Default Agent',
      type: 'text' as const,
      required: true,
      placeholder: 'agent-uuid',
      help: '私聊默认走这个 agent',
    },
    {
      key: 'autoReconnect',
      label: 'Auto Reconnect',
      type: 'checkbox' as const,
      help: '断线后自动重连(指数退避 1s → 5min)',
    },
  ],
};

/** SQL migration — creates channels_wechat table. */
export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS channels_wechat (
  id                  TEXT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  default_agent_id    TEXT,
  current_session_id  TEXT,
  storage_dir         TEXT NOT NULL,
  auto_reconnect      INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channels_wechat_enabled ON channels_wechat(enabled);
`;