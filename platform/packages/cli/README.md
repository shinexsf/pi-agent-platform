# pi-server

CLI for installing, running, and managing the **pi-agent-platform** server.

## Install

The package is distributed as a tarball (private, not on npmjs.com):

```bash
# build (in dev repo)
pnpm pack:cli
# produces: packages/cli/pi-server-0.0.1-alpha.tgz

# install (on target machine)
npm install -g ./pi-server-0.0.1-alpha.tgz
```

> Note: `pack:cli` is the only build command — it aggregates server + worker +
> channels + SPA into `packages/cli/dist/` and immediately produces the tarball
> in one step. `better-sqlite3` is **not** bundled; it is installed as a
> regular npm dependency at `npm install -g` time, which triggers its
> `install` hook (prebuild-install || node-gyp rebuild).

After install, `pi-server`, `pi-server.cmd`, and `pi-server.ps1` are on your PATH.

## Commands

| Command | What it does |
|---|---|
| `pi-server start` | Spawn the server in the background (detached). Idempotent: errors if already running. |
| `pi-server stop` | Gracefully terminate the server (SIGTERM → SIGKILL on POSIX, `taskkill /F` on Windows). |
| `pi-server status` | Print `running/not running` plus pid, port, uptime, and health probe. |
| `pi-server logs [-f]` | Print the server log. `-f` follows new lines (Ctrl+C to stop). |

All commands write diagnostics to **stderr** (prefixed `[pi-server]`), and command results to **stdout**.

## Data directory

The CLI keeps all user data in a single directory, separated from the npm install location:

| Platform | Path |
|---|---|
| Linux / macOS | `$HOME/.pi/server/` |
| Windows | `%USERPROFILE%\.pi\server\` |

Layout:

```
.pi/server/
├── data/data.db              ← SQLite
├── attachments/              ← user-uploaded images
├── logs/server.log           ← server stdout/stderr
└── run/server.pid            ← daemon PID
```

Upgrading (`npm install -g ./pi-server-X.Y.Z.tgz`) **never** touches this directory.

## Upgrading

```bash
# 1. Build a new tarball in the dev repo
pnpm pack:cli

# 2. Install on the target machine
npm install -g ./pi-server-0.0.2-alpha.tgz

# 3. Restart the service
pi-server stop
pi-server start
```

To **roll back**, install an older tarball version. To **uninstall**:

```bash
npm uninstall -g pi-server
# User data in ~/.pi/server/ is preserved.
# Pass --purge to pi-server uninstall to also wipe data (not implemented in MVP).
```

## Migrating from dev-mode data

If you have existing data in dev (`apps/pi-agent-server/data.db`):

```bash
mkdir -p ~/.pi/server/data
cp apps/pi-agent-server/data.db ~/.pi/server/data/
```

Then `pi-server start` will pick up where you left off.

## Environment variables

The CLI injects 7 variables into the server child process at start:

| Variable | Purpose |
|---|---|
| `PI_SERVER_CLI=1` | Marker — tells the server "you're running under pi-server CLI" |
| `NODE_ENV=production` | Disables debug routes |
| `WORKER_DIST_DIR` | Absolute path to the bundled worker dist |
| `PI_DATA_DIR` | Absolute path to the SQLite directory |
| `PI_ATTACHMENTS_ROOT` | Absolute path to user uploads |
| `CHANNELS_DIR` | Absolute path to the bundled IM channels |
| `PUBLIC_DIR` | Absolute path to the bundled SPA public/ |

These are **child-process-only** — your shell's environment is not affected.

You can override the port via `PORT` before running `pi-server start`:

```bash
PORT=8080 pi-server start
```

## Platform support

- **Node.js** >= 22
- Tested on Windows + Linux (macOS should work; POSIX paths)
- `better-sqlite3` is installed via npm's standard `install` hook at `npm install -g` time. The hook runs `prebuild-install || node-gyp rebuild`. If your machine has neither a prebuilt binary available (slow GitHub access) nor the native build toolchain (Windows: VS Build Tools / Linux: gcc + python), the install will fail — see [Troubleshooting](#troubleshooting) below.

## Versioning

This is the **0.0.1-alpha** release. Expect rough edges. Until we hit 1.0.0, minor versions may include breaking changes — always check the upgrade notes.

## Troubleshooting

### `better-sqlite3` install fails with `node-gyp` / `gyp ERR! find VS`

This means the `install` hook in `better-sqlite3` couldn't find a prebuilt binary and fell back to a local native build, which needs Visual Studio Build Tools on Windows / gcc + python on Linux.

**Options** (in increasing order of effort):

1. **Wait and retry** — `prebuild-install` downloads from GitHub Releases, which can be slow or blocked on some networks.
2. **Install build tools**:
   - Windows: install [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) with the "Desktop development with C++" workload, then re-run `npm install -g ./pi-server-0.0.1-alpha.tgz`.
   - Linux: `apt install build-essential python3` (or equivalent).
3. **Use a precompiled binary manually** — download `better-sqlite3-v11.5.0-napi-v3-win32-x64.tar.gz` (or your platform) from <https://github.com/WiseLibs/better-sqlite3/releases/tag/v11.5.0>, extract to `<global-node_modules>/better-sqlite3/`, and ensure `build/Release/better_sqlite3.node` lands at the right path.

If `pi-server start` says `Error: Cannot open database because the directory does not exist` or `Cannot find module 'better-sqlite3'`, the native binding isn't where Node expects it.