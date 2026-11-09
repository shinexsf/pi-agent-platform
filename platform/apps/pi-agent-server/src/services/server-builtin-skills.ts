/**
 * Platform-shipped skills (change: server-builtin-skills).
 *
 * Source of truth for the `GET /api/config/server-builtin-skills` catalogue and for the
 * config-issue check. The files themselves live inside the installed server package
 * (`skills/builtin/<name>/SKILL.md`) and are shipped by `build-cli.mjs` — they are NOT user
 * assets: nothing here writes, and `GET /api/config/skills` (the user's `~/.pi/agent/skills`)
 * deliberately does not list them.
 *
 * The worker loads the selected ones through pi's `additionalSkillPaths`; this module only
 * answers "what is available right now".
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ServerBuiltinSkillInfo } from '@pi-agent-platform/api-types';
import { config } from '../config.js';
import { childLogger } from '../logger.js';

const logger = childLogger('server-builtin-skills');

/** Directory mtime is a cheap invalidation key (upgrades replace the whole dir). */
const CACHE_TTL_MS = 2_000;
let cache: { at: number; dir: string | undefined; items: ServerBuiltinSkillInfo[] } | null = null;

/**
 * Pull `name` / `description` out of a `SKILL.md` frontmatter block.
 * Deliberately a tiny parser (no YAML dependency): descriptions are single scalars and may
 * be wrapped onto continuation lines. Frontmatter is optional — the directory name is the
 * fallback name, and a missing description yields "" (the entry is still listed so users can
 * see that something is wrong instead of silently losing a skill).
 */
export function parseSkillFrontmatter(raw: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return {};
  const body = match[1] ?? '';
  const out: { name?: string; description?: string } = {};

  const readScalar = (key: string): string | undefined => {
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      const m = new RegExp(`^${key}\\s*:\\s*(.*)$`).exec(line);
      if (!m) continue;
      const parts = [(m[1] ?? '').trim()];
      // Continuation lines: indented and not a new `key:` pair.
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j] ?? '';
        if (!next.trim()) break;
        if (/^[A-Za-z][\w-]*\s*:/.test(next)) break;
        if (!/^\s+/.test(next)) break;
        parts.push(next.trim());
      }
      const joined = parts.filter(Boolean).join(' ').trim();
      if (!joined) return undefined;
      // Strip one layer of matching quotes (frontmatter may quote the scalar).
      const quoted = /^(['"])([\s\S]*)\1$/.exec(joined);
      return quoted ? quoted[2] : joined;
    }
    return undefined;
  };

  out.name = readScalar('name');
  out.description = readScalar('description');
  return out;
}

function scan(dir: string): ServerBuiltinSkillInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch (err) {
    logger.warn({ dir, err: String(err) }, 'builtin skill directory unreadable — catalogue empty');
    return [];
  }
  const items: ServerBuiltinSkillInfo[] = [];
  for (const entry of entries) {
    const skillFile = path.join(dir, entry, 'SKILL.md');
    try {
      if (!statSync(path.join(dir, entry)).isDirectory() || !existsSync(skillFile)) continue;
      const meta = parseSkillFrontmatter(readFileSync(skillFile, 'utf-8'));
      const name = (meta.name ?? entry).trim();
      if (!name) continue;
      if (!meta.description) {
        logger.warn({ name, skillFile }, 'builtin skill has no description — model will not see it');
      }
      items.push({ name, description: meta.description ?? '', path: skillFile, builtin: true });
    } catch (err) {
      logger.warn({ entry, err: String(err) }, 'builtin skill entry skipped');
    }
  }
  return items;
}

/** Available builtin skills for this installation (cached ~2s; empty when the dir is absent). */
export function listServerBuiltinSkills(): ServerBuiltinSkillInfo[] {
  const dir = config.serverBuiltinSkillsDir;
  const now = Date.now();
  if (cache && cache.dir === dir && now - cache.at < CACHE_TTL_MS) return cache.items;
  const items = dir ? scan(dir) : [];
  cache = { at: now, dir, items };
  if (items.length > 0) logger.debug({ dir, names: items.map((i) => i.name) }, 'builtin skill catalogue');
  return items;
}

/** Names only — what `findConfigIssues` needs. */
export function listServerBuiltinSkillNames(): string[] {
  return listServerBuiltinSkills().map((s) => s.name);
}
