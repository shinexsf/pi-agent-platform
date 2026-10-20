/**
 * Built-in extension injection for the tool whitelist (`AgentConfig.builtinTools`).
 *
 * pi 1.1.0 ships four built-in extensions inside `dist/extensions/index.js`
 * (`llama.cpp` / `codemode` / `tool-search` / `mcp`), but:
 * - only the CLI (`dist/main.js`) injects them — the SDK path has no injection point;
 * - they are NOT exported from the package root (`exports` = `.`, `./rpc-entry`,
 *   `./client`, `./experimental/plugin`; `.` itself is ESM-only: `{types, import}`).
 *
 * So we locate the dist file ourselves and dynamic-import it (see loadBuiltinTable()).
 *
 * Verified against pi 1.1.0 dist (P0 experiments of change builtin-tools-unified-management):
 * - `import.meta.resolve()` resolves the package entry; `createRequire().resolve()` throws
 *   `ERR_PACKAGE_PATH_NOT_EXPORTED` because `.` has no `require` condition.
 * - Injection needs TWO things: the factory in loader `extensionFactories` (builds the
 *   builtin code table, resource-loader.js:247) AND `builtin:<name>` in
 *   `additionalExtensionPaths` (the actual load trigger, resolved in reload() → merged
 *   into the extension path list). Factory alone never loads; path alone fails with
 *   "Unknown built-in extension".
 * - A loaded builtin extension registers as path `builtin:<name>` with `sourceInfo.source
 *   === 'builtin'` (getSyntheticPathSource), so the existing whitelist filter
 *   (`sourceInfo.source === 'builtin'`) governs extension tools too — codemode/tool_search
 *   are NOT treated as "always-on non-builtin tools".
 * - `mcp` connects servers on `session_start` (empty/missing `mcp.json` loads clean:
 *   no tools, no errors/warnings).
 * - `pi-mcp-adapter` (non-replaceable) wins over `builtin:mcp` via omitReplacedExtensions:
 *   the builtin is dropped with a warning, never both connected.
 *
 * ⚠ Version coupling: if a future pi release moves `dist/extensions/index.js` or finally
 * exports `builtInExtensions` from the package root, update loadBuiltinTable(). Failures
 * degrade gracefully (no extensions injected; plain builtin tool whitelist keeps working).
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ExtensionFactory, InlineExtension } from '@earendil-works/pi-coding-agent';
import { logger } from './logger.js';

const log = logger.child({ module: 'builtin-extensions' });

/**
 * Tool name → pi built-in extension name.
 * `tool_search` (tool name) maps to `tool-search` (extension name) — they differ.
 * `llama.cpp` is intentionally absent: it registers a model provider, not a tool.
 */
const TOOL_TO_EXTENSION: Readonly<Record<string, string>> = {
  codemode: 'codemode',
  tool_search: 'tool-search',
  mcp: 'mcp',
};

/** Minimal shape of pi's `builtInExtensions` entries (not exported by the package). */
interface PiBuiltinExtension {
  name: string;
  factory: ExtensionFactory;
  replaceable?: boolean;
}

/**
 * Extensions implied by selecting `mcp`.
 *
 * An mcp server's tools reach the model according to its `exposure` in mcp.json:
 * - `codemode` (default) → needs the codemode tool;
 * - `deferred` → needs tool_search.
 * We cannot know a project's exposures before connecting, so `mcp` always brings both along.
 * (codemode / tool_search remain independently selectable without mcp.)
 */
const MCP_IMPLIED_TOOLS: readonly string[] = ['codemode', 'tool_search'];

/** What the session loader needs to load the selected built-in extensions. */
export interface BuiltinExtensionInjection {
  /** Factories merged into `DefaultResourceLoader.extensionFactories`. */
  factories: InlineExtension[];
  /** `builtin:<name>` entries for `DefaultResourceLoader.additionalExtensionPaths`. */
  extensionPaths: string[];
  /**
   * Tool names to activate: the requested list plus anything implied by it (`mcp` →
   * codemode + tool_search). Callers use this instead of the raw config list so a hand-edited
   * API payload cannot produce a list that loads mcp but no way to reach its tools.
   */
  toolNames: string[];
}

/** Cached lookup (including a failed attempt — never retried per session). */
let tablePromise: Promise<Map<string, PiBuiltinExtension> | undefined> | undefined;

async function loadBuiltinTable(): Promise<Map<string, PiBuiltinExtension> | undefined> {
  tablePromise ??= (async () => {
    try {
      const entryUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
      const distDir = dirname(fileURLToPath(entryUrl));
      const extensionsUrl = pathToFileURL(join(distDir, 'extensions', 'index.js')).href;
      const mod = (await import(extensionsUrl)) as { builtInExtensions?: PiBuiltinExtension[] };
      const list = mod.builtInExtensions;
      if (!Array.isArray(list) || list.length === 0) {
        log.warn({ extensionsUrl }, 'pi builtInExtensions is empty/missing; builtin extensions unavailable');
        return undefined;
      }
      return new Map(list.map((ext) => [ext.name, ext]));
    } catch (err) {
      log.warn({ err }, 'failed to load pi built-in extensions; falling back to plain tool whitelist');
      return undefined;
    }
  })();
  return tablePromise;
}

/**
 * Resolve the built-in extensions required by a `builtinTools` list.
 *
 * Returns `undefined` when nothing needs injecting (null/empty list, no extension tool
 * names, or the pi table could not be loaded) — callers then behave exactly as before.
 */
export async function resolveBuiltinExtensionInjection(
  toolNames: readonly string[] | null | undefined,
): Promise<BuiltinExtensionInjection | undefined> {
  if (!toolNames || toolNames.length === 0) return undefined;

  const requested = [...new Set(toolNames)];
  const implied = requested.includes('mcp')
    ? MCP_IMPLIED_TOOLS.filter((name) => !requested.includes(name))
    : [];
  if (implied.length > 0) {
    log.info({ requested, added: implied }, 'builtin tools: mcp implies codemode+tool_search; auto-enabled');
  }
  const effective = [...requested, ...implied];

  const extensionNames = [
    ...new Set(effective.map((name) => TOOL_TO_EXTENSION[name]).filter((name): name is string => !!name)),
  ];
  if (extensionNames.length === 0) return undefined;

  const table = await loadBuiltinTable();
  if (!table) return undefined;

  const factories: InlineExtension[] = [];
  const extensionPaths: string[] = [];
  for (const name of extensionNames) {
    const builtin = table.get(name);
    if (!builtin) {
      log.warn({ extension: name }, 'built-in extension not found in pi dist; skipped');
      continue;
    }
    factories.push({ name: builtin.name, hidden: true, factory: builtin.factory });
    extensionPaths.push(`builtin:${name}`);
  }
  if (factories.length === 0) return undefined;

  log.info({ extensions: extensionNames }, 'injecting pi built-in extensions');
  return { factories, extensionPaths, toolNames: effective };
}
