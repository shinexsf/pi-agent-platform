/**
 * QQ channel config schema.
 */
export interface QqChannelConfig {
  id: string;
  type: 'qq';
  displayName: string;
  enabled: boolean;
  defaultAgentId?: string;
  currentSessionId?: string;
  appId: string;
  appSecret: string;
  /** Mock-only: simulate auto-reconnect. */
  autoReconnect?: boolean;
  createdAt: number;
  updatedAt: number;
}

export const SCHEMA_HINTS = {
  configFields: [
    {
      key: 'displayName',
      label: 'Channel Name',
      type: 'text' as const,
      required: true,
      placeholder: 'e.g. QQ 客服',
    },
    {
      key: 'appId',
      label: 'App ID',
      type: 'text' as const,
      required: true,
      placeholder: '你的 QQ 机器人 appId',
      help: 'QQ 开放平台 → 应用详情',
    },
    {
      key: 'appSecret',
      label: 'App Secret',
      type: 'password' as const,
      required: true,
      placeholder: '你的 QQ 机器人 appSecret',
      help: 'token endpoint 用',
    },
    {
      key: 'defaultAgentId',
      label: 'Default Agent',
      type: 'text' as const,
      required: true,
      placeholder: 'agent-uuid',
    },
  ],
};

/** MVP schema: channels_qq only. No channels_qq_routes (deferred). */
export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS channels_qq (
  id                  TEXT PRIMARY KEY,
  display_name        TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  default_agent_id    TEXT,
  current_session_id  TEXT,
  app_id              TEXT NOT NULL,
  app_secret          TEXT NOT NULL,
  auto_reconnect      INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channels_qq_enabled ON channels_qq(enabled);
`;