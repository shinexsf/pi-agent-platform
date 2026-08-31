#!/usr/bin/env node
/**
 * Copy SPA build output into pi-agent-server's static host directory.
 *
 * Usage:
 *   node scripts/copy-spa.mjs --src=<dist-dir> --dst=<server-public-dir>
 *
 * Steps:
 *   1. Wipe the destination directory (rm -rf) so stale files from a previous
 *      build (e.g. removed chunks, renamed assets) don't linger.
 *   2. Recreate the destination directory.
 *   3. Copy every entry under --src into --dst recursively.
 *
 * The destination must be the `public/<appName>` directory that
 * pi-agent-server mounts via `serveStatic` (see apps/pi-agent-server/src/index.ts).
 */

import { rm, mkdir, cp, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

function parseArgs(argv) {
  const args = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

const { src, dst } = parseArgs(process.argv);
if (!src || !dst) {
  console.error('Usage: node scripts/copy-spa.mjs --src=<dist-dir> --dst=<server-public-dir>');
  process.exit(1);
}

// Resolve against CWD so callers can pass repo-relative paths (the package.json
// scripts always run with CWD = platform/).
const srcAbs = resolve(process.cwd(), src);
const dstAbs = resolve(process.cwd(), dst);

await rm(dstAbs, { recursive: true, force: true });
await mkdir(dstAbs, { recursive: true });

const entries = await readdir(srcAbs);
for (const entry of entries) {
  await cp(join(srcAbs, entry), join(dstAbs, entry), { recursive: true });
}

console.log(`[copy-spa] copied ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} from ${srcAbs} → ${dstAbs}`);