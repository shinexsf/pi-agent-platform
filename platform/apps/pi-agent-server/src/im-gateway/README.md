# im-gateway (server-side)

**IM gateway host module for QQ (WebSocket) and WeChat (iLink HTTP long-poll).**

Loads channel packages from `channels/manifest.json`, mounts routes under `/api/im/*`, manages in-memory session state, dispatches inbound messages to workers, and handles reply dispatch.

## Module layout

```
src/im-gateway/
├── index.ts                    # startImGateway(deps) — entry, called from server/index.ts
├── types.ts                    # internal: RegisteredChannel / BuiltinCommand
├── logger.ts                   # pino logger (name: im-gateway)
├── channel-loader.ts           # reads manifest.json + dynamic import per channel package
├── channel-host-impl.ts        # ChannelHost impl (19 methods + helpers for routes)
├── channel-registry.ts         # channelId → RegisteredChannel map (status tracking)
├── session-channel-map.ts      # in-memory Map<sessionId, SessionMeta> + reverse index
├── session-bridge.ts           # spawnPlaceholder / spawnAndCreate (shared with routes/sessions.ts)
├── routing.ts                  # three-state lifecycle + slash commands + QQ group fast-fail
├── slash-commands.ts           # 6 builtin commands (/help /new /session /model /think /compact)
├── reply-sender.ts             # worker message_update → message_end → adapter.sendText
└── routes/
    └── im-gateway.ts           # main /api/im/{manifest,health,channels,debug/state,debug/logs}
```

## Wiring (server/index.ts)

```typescript
import { startImGateway } from './im-gateway/index.js';

const imGatewayHandle = await startImGateway({
  app,            // Hono app
  agentRepo,      // from createAgentRepo
  sessionRepo,    // from createSessionRepo
  workerPool,
  rawDb: raw,     // better-sqlite3 Database
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await imGatewayHandle.shutdown();
});
```

## Public routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/im/manifest` | List enabled channels (server-authoritative) |
| `GET` | `/api/im/health` | All channels with live status snapshot |
| `GET` | `/api/im/channels` | Aggregate channel config list |
| `GET` | `/api/im/debug/state` | **Dev only**: full internal state (session map + adapters + QQ notified set) |
| `GET` | `/api/im/debug/logs` | **Dev only**: SSE stream of channel log events |
| `GET` | `/api/im/<type>/channels` | Channel CRUD (mounted per type, see channel package) |

## Architecture invariants

1. **Main package zero channel knowledge** — no `wechat` / `qq` literals in pi-agent-server source (except im-gateway internal).
2. **Channel tables owned by channel packages** — DDL declared in `host.executeMigration()`, never in server's `db/init.ts`.
3. **session-channel-map is in-memory only** — no `sessions.source` column. Respawn on first inbound after restart (see design D16).
4. **Worker package untouched** — `sendFileToUser` tool deferred to next change (per MVP scope).

## Testing

```bash
npx vitest run
# 9 tests passing
```

Coverage:
- manifest / health / channels aggregate routes
- session-channel-map CRUD + reverse lookup + touch
- QQ group fast-fail dedup via Set

## Design references

- `openspec/changes/im-gateway/` — full design + specs + tasks
- `doc/architecture/current/pi-agent-server_im-gateway.md` — architecture summary
- `doc/architecture/current/pi-agent-server_db-schema.md` — channel table ownership rules
- `reference/projects/personal-agent-manage/pi-qq-bot/` + `pi-wechat-bot/` — historical implementations (read-only)