#!/usr/bin/env node
// Thin shim so npm can wire `pi-server` → this file as the bin entry.
// On Windows, npm also generates `pi-server.cmd` and `pi-server.ps1` that
// delegate to this script via node.

import('../dist/bin.js').catch((err) => {
  // No logger yet (it lives in dist/) — fall back to raw stderr.
  process.stderr.write(`[pi-server] failed to start: ${err?.stack ?? err}\n`);
  process.exit(1);
});