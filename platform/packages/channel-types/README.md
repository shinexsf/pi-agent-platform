# channel-types

**Shared interfaces between the server-side IM gateway and frontend admin pages.**

Dual-target package: same type module exports Node (`ChannelAdapter` / `ChannelHost` / `ChannelPackage`) and DOM (`ChannelAdminPage` / `ChannelAdminHost`) interfaces. No runtime code — pure types.

## 5 interfaces & strict call direction

```
┌────────────────────────────────────────────────────────────────────┐
│  Main package (pi-agent-server / pi-agent-web)                      │
│                                                                    │
│  implements → ChannelHost          (18 methods, server-side)       │
│  implements → ChannelAdminHost     (4 methods, browser-side)       │
│                                                                    │
└──────────┬─────────────────────────────────┬────────────────────────┘
           │ host.registerRoutes / …        │ window.__channelAdminHost
           ▼                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  Channel package (channel-wechat / channel-qq / future)            │
│                                                                    │
│  implements → ChannelAdapter       (host → package)                │
│  implements → ChannelAdminPage     (host renders)                  │
│  exposes    → ChannelPackage       (entry — register(host))        │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## Call direction rules (P1 — main-package zero channel knowledge)

| From | To | Allowed method | Forbidden |
|---|---|---|---|
| Host → Package | `ChannelAdapter` (11 methods) | `start / stop / sendText / sendImage / sendFile / onMessage / ...` | — |
| Package → Host | `ChannelHost` (19 methods) | `executeMigration / registerRoutes / getChannelConfig / prompt / parseCommand / logEvent / ...` | direct DB access, direct worker spawn |
| Host → Package | `ChannelAdminPage` (5 fields) | `navItem / component / subRoutes` | — |
| Package → Host (DOM) | `ChannelAdminHost` (4 methods) | `apiFetch / showToast / showConfirmDialog / useI18n` | direct fetch with hardcoded URL, direct DOM mutation outside host primitives |

## Verification

```bash
pnpm -r typecheck
# 12 packages should all pass with 0 errors
```

## Adding a new channel

1. Create `platform/channels/channel-<name>/` with `package.json` referencing `@pi-agent-platform/channel-types: workspace:*`.
2. Implement `src/index.ts` exporting a `ChannelPackage`:
   - `register(host)` calls `host.executeMigration(name, sql)` and `host.registerRoutes(prefix, honoRouter)`.
3. Implement `src/admin/index.ts` exporting a `ChannelAdminPage`.
4. Add to `channels/manifest.json`.

The web bundle auto-discovers via `import.meta.glob('/channels/*/src/admin/index.ts')`; the server loads via dynamic import of each manifest entry.