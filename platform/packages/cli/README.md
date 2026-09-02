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
> channels + SPA + better-sqlite3 native binary into `packages/cli/dist/` and
> immediately produces the tarball in one step.

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
- The native `better-sqlite3` binary is downloaded by `prebuild-install` on `npm install` for your OS + arch

## Versioning

This is the **0.0.1-alpha** release. Expect rough edges. Until we hit 1.0.0, minor versions may include breaking changes — always check the upgrade notes.