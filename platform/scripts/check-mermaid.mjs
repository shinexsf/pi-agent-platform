#!/usr/bin/env node
/**
 * check-mermaid.mjs — validate every ```mermaid block in docs via real mermaid.parse().
 *
 * Usage:
 *   node scripts/check-mermaid.mjs              # scan ../../doc (repo docs)
 *   node scripts/check-mermaid.mjs <path>...    # scan specific files/dirs
 *
 * Deps: mermaid + jsdom (workspace devDependencies — installed for exactly this).
 * Run from platform/ (or anywhere — paths resolve relative to this file).
 *
 * Exit code: 0 = all blocks parse; 1 = at least one block broken.
 */

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

// ── DOM globals MUST be installed before mermaid (dompurify needs window) ──
const { window } = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
const g = globalThis;
g.window = window;
g.document = window.document;
g.HTMLElement = window.HTMLElement;
g.SVGElement = window.SVGElement;
g.Element = window.Element;
g.Node = window.Node;
g.DOMParser = window.DOMParser;
g.XMLSerializer = window.XMLSerializer;
g.getComputedStyle = window.getComputedStyle.bind(window);
try {
  Object.defineProperty(g, 'navigator', { value: window.navigator, configurable: true });
} catch {
  /* Node >=21 ships a read-only navigator; mermaid.parse tolerates it */
}

const mermaid = (await import('mermaid')).default;
mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' });

// ── collect files ──
function walk(p, out = []) {
  if (!existsSync(p)) return out;
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) walk(join(p, name), out);
  } else if (p.endsWith('.md')) {
    out.push(p);
  }
  return out;
}

const targets = process.argv.slice(2);
const files = targets.length
  ? targets.flatMap((t) => walk(resolve(process.cwd(), t)))
  : walk(join(REPO_ROOT, 'doc'));

if (files.length === 0) {
  console.error('no .md files found');
  process.exit(1);
}

// ── extract + parse ──
let total = 0;
let failed = 0;
const failures = [];

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  let lang = null;
  let startLine = 0;
  let buf = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inBlock && /^```mermaid\s*$/.test(line)) {
      inBlock = true;
      lang = null;
      startLine = i + 1;
      buf = [];
      continue;
    }
    if (inBlock && /^```\s*$/.test(line)) {
      inBlock = false;
      total++;
      const code = buf.join('\n');
      const first = buf[0]?.trim() ?? lang;
      try {
        await mermaid.parse(code);
      } catch (err) {
        failed++;
        const msg = String(err?.message ?? err).split('\n').slice(0, 4).join(' | ');
        failures.push({ file: relative(REPO_ROOT, file), startLine, type: first, msg });
      }
      continue;
    }
    if (inBlock) buf.push(line);
  }
  if (inBlock) {
    failed++;
    failures.push({ file: relative(REPO_ROOT, file), startLine, type: 'UNCLOSED', msg: 'fence never closed' });
  }
}

if (failures.length) {
  console.error(`FAIL: ${failed}/${total} mermaid blocks broken`);
  for (const f of failures) {
    console.error(`  ${f.file}:${f.startLine} [${f.type}]\n    ${f.msg}`);
  }
  process.exit(1);
}
console.log(`OK: ${total} mermaid blocks parsed in ${files.length} files`);
