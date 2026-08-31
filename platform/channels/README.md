# platform/channels

IM channel packages. Each package provides both `ChannelPackage` (backend, Node target) and `ChannelAdminPage` (frontend, DOM target).

## Currently enabled

Listed in `manifest.json` — server reads via dynamic import, web reads via `import.meta.glob`.

## Adding a new channel

1. Create `platform/channels/channel-<name>/` with `package.json` (`@pi-agent-platform/channel-types: workspace:*`)
2. Implement `src/index.ts` exporting `ChannelPackage` (backend)
3. Implement `src/admin/index.ts` exporting `ChannelAdminPage` (frontend)
4. Add to `manifest.json` `channels` array
5. Add to root `pnpm-workspace.yaml` `packages: - 'channels/*'` (already present)
6. Run `pnpm install`

## Contract

See [`../packages/channel-types/](../packages/channel-types/)` for the 5 interfaces.

## License notes

- `channel-qq` uses `qq-bot-sdk` (AGPL-3.0) — see package README
- `channel-wechat` uses `@wechatbot/wechatbot` (iLink ClawBot, iOS-only constraint)