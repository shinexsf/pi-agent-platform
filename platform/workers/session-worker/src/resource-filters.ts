/**
 * Resource filter functions for agent config.
 * These functions are used as Override callbacks for DefaultResourceLoader.
 */

import path from 'node:path';
import type { LoadExtensionsResult, Skill, ResourceDiagnostic } from '@earendil-works/pi-coding-agent';
import type { PromptTemplate } from '@earendil-works/pi-coding-agent';

/**
 * Build the normalized project-local .pi/extensions/ directory prefix for path matching.
 * Extensions under this path are always loaded (not filtered by agent config whitelist).
 */
function buildProjectExtDirPrefix(cwd: string): string {
  return path.resolve(cwd, '.pi', 'extensions').replace(/\\/g, '/').toLowerCase() + '/';
}

/**
 * Filter extensions based on agent config.extensions whitelist.
 * If extensions is null/undefined, all extensions are allowed.
 * If extensions is empty array, no extensions are allowed.
 *
 * Project-local extensions (under <cwd>/.pi/extensions/) are always loaded
 * regardless of the whitelist — they belong to the project, not the server.
 *
 * Inline extensions (`<inline:...>` — worker 注入的 systemPrompt takeover 等，经
 * DefaultResourceLoader `extensionFactories` 装载) are ALWAYS kept: pi loads inline
 * factories inside `loadFinalExtensionSet` BEFORE `extensionsOverride` runs (verified
 * on pi 1.1.0 dist resource-loader.js), so without this exemption the agent's
 * extension whitelist would kill the worker's own takeover handler.
 *
 * Worker-injected pi built-in extensions (`builtin:codemode` / `builtin:tool-search` /
 * `builtin:mcp`, driven by `AgentConfig.builtinTools`) are kept too, but only the exact
 * paths we injected (`injectedExtensions`) — a `builtin:*` entry that merely comes from
 * settings.json stays subject to the whitelist.
 */
export function createExtensionsFilter(
  allowedExtensions?: string[],
  cwd?: string,
  injectedExtensions?: readonly string[],
): (base: LoadExtensionsResult) => LoadExtensionsResult {
  const injectedSet = new Set(injectedExtensions ?? []);
  return (base) => {
    // No filter configured — allow all
    if (allowedExtensions === null || allowedExtensions === undefined) {
      return base;
    }

    // Empty array — no extensions allowed (but project-local + inline still kept)
    if (allowedExtensions.length === 0) {
      if (!cwd) return { ...base, extensions: base.extensions.filter((ext) => isKeptExtension(ext.path, injectedSet)) };
      const projectPrefix = buildProjectExtDirPrefix(cwd);
      return {
        ...base,
        extensions: base.extensions.filter(
          (ext) =>
            isKeptExtension(ext.path, injectedSet) || isProjectLocal(ext.resolvedPath, projectPrefix),
        ),
      };
    }

    const allowedSet = new Set(allowedExtensions.map((n) => n.toLowerCase()));
    const projectPrefix = cwd ? buildProjectExtDirPrefix(cwd) : null;

    const filtered = base.extensions.filter((ext) => {
      // Worker-injected inline/builtin extensions: always keep (see doc comment)
      if (isKeptExtension(ext.path, injectedSet)) return true;
      // Project-local extensions: always keep
      if (projectPrefix && isProjectLocal(ext.resolvedPath, projectPrefix)) return true;
      // Global / other extensions: whitelist filter
      const name = extractExtensionName(ext.path);
      const resolvedName = extractExtensionName(ext.resolvedPath);
      return allowedSet.has(name.toLowerCase()) || allowedSet.has(resolvedName.toLowerCase());
    });

    return { ...base, extensions: filtered };
  };
}

/** Extensions the worker injected itself: always kept regardless of the whitelist.
 *  - `<inline:...>`: systemPrompt takeover factory (extensionFactories)
 *  - exact `builtin:<name>` paths we passed via additionalExtensionPaths */
function isKeptExtension(extPath: string, injectedSet: ReadonlySet<string>): boolean {
  return isInlineExtension(extPath) || injectedSet.has(extPath);
}

/** Whether an extension path is a pi inline extension (`<inline:...>`),
 *  e.g. worker 注入的 systemPrompt takeover（经 extensionFactories 装载）。 */
function isInlineExtension(extPath: string): boolean {
  return extPath.startsWith('<inline:');
}

/** Check if a resolved extension path is under the project-local .pi/extensions/ dir. */
function isProjectLocal(resolvedPath: string, projectPrefix: string): boolean {
  return resolvedPath.replace(/\\/g, '/').toLowerCase().startsWith(projectPrefix);
}

/**
 * Filter skills based on agent config.skills whitelist.
 * If skills is null/undefined, all skills are allowed.
 * If skills is empty array, no skills are allowed.
 *
 * Project-local skills (sourceInfo.scope === "project") are always loaded
 * regardless of the whitelist — they belong to the project, not the server.
 */
/**
 * Filter skills based on agent config.skills whitelist.
 * If skills is null/undefined, all skills are allowed.
 * If skills is empty array, no skills are allowed.
 *
 * Always-kept regardless of the whitelist:
 * - Project-local skills (`sourceInfo.scope === "project"`) — they belong to the project, not the server.
 * - Extension-injected skills (`sourceInfo.scope === "temporary"`) — contributed at runtime via an
 *   extension's `resources_discover` handler (e.g. @amaster.ai/pi-lark returns its bundled
 *   `skills/` dir). The whitelist governs the user's own skill directories; a skill whose only
 *   source is an extension the user explicitly enabled would otherwise be unreachable. Mirrors
 *   the `<inline:` exemption in createExtensionsFilter.
 *
 * Note: pi re-applies this override from `resourceLoader.extendResources()` → `updateSkillsFromPaths()`,
 * so extension-injected skills pass through here a second time — the temporary-scope exemption is
 * what makes them survive.
 */
export function createSkillsFilter(
  allowedSkills?: string[],
): (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  const isAlwaysKept = (skill: Skill): boolean => {
    const scope = skill.sourceInfo?.scope;
    return scope === 'project' || scope === 'temporary';
  };

  return (base) => {
    // No filter configured — allow all
    if (allowedSkills === null || allowedSkills === undefined) {
      return base;
    }

    // Empty array — no skills allowed (but project-local and extension-injected still kept)
    if (allowedSkills.length === 0) {
      return { ...base, skills: base.skills.filter(isAlwaysKept) };
    }

    const allowedSet = new Set(allowedSkills.map((n) => n.toLowerCase()));

    const filtered = base.skills.filter((skill) => {
      if (isAlwaysKept(skill)) return true;
      // Global / other skills: whitelist filter
      return allowedSet.has(skill.name.toLowerCase());
    });

    return { ...base, skills: filtered };
  };
}

/**
 * Filter prompts based on agent config.prompts whitelist.
 * If prompts is null/undefined, all prompts are allowed.
 * If prompts is empty array, no prompts are allowed.
 *
 * Project-local prompts (sourceInfo.scope === "project") are always loaded
 * regardless of the whitelist — they belong to the project, not the server.
 * Extension-injected prompts (sourceInfo.scope === "temporary", contributed via an extension's
 * `resources_discover` handler) are always kept as well — same reasoning as createSkillsFilter.
 */
export function createPromptsFilter(
  allowedPrompts?: string[],
): (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
  const isAlwaysKept = (prompt: PromptTemplate): boolean => {
    const scope = prompt.sourceInfo?.scope;
    return scope === 'project' || scope === 'temporary';
  };

  return (base) => {
    // No filter configured — allow all
    if (allowedPrompts === null || allowedPrompts === undefined) {
      return base;
    }

    // Empty array — no prompts allowed (but project-local / extension-injected still kept)
    if (allowedPrompts.length === 0) {
      return { ...base, prompts: base.prompts.filter(isAlwaysKept) };
    }

    const allowedSet = new Set(allowedPrompts.map((n) => n.toLowerCase()));

    const filtered = base.prompts.filter((prompt) => {
      if (isAlwaysKept(prompt)) return true;
      // Global / other prompts: whitelist filter
      return allowedSet.has(prompt.name.toLowerCase());
    });

    return { ...base, prompts: filtered };
  };
}

/**
 * Extract extension name from a file path or source string.
 * - "/path/to/node_modules/pi-mcp-adapter/index.ts" → "pi-mcp-adapter"
 * - "/path/to/node_modules/@scope/pkg-name/src/index.ts" → "@scope/pkg-name"
 * - "/path/to/plugin-dir/src/index.ts" → "plugin-dir"
 * - "npm:pi-mcp-adapter" → "pi-mcp-adapter"
 * - "npm:@scope/pkg-name" → "@scope/pkg-name"
 */
export function extractExtensionName(filePath: string): string {
  // Handle npm packages (preserve scope)
  if (filePath.startsWith('npm:')) {
    return filePath.slice(4);
  }
  
  // Handle git sources
  if (filePath.startsWith('git:')) {
    const repoPath = filePath.slice(4).split('@')[0] ?? '';
    return path.basename(repoPath);
  }
  
  // Handle file paths - try to extract from node_modules structure first
  // e.g., /path/to/node_modules/@scope/pkg-name/src/index.ts → @scope/pkg-name
  const nodeModulesMatch = filePath.match(/node_modules[/\\]((?:@[^/\\]+[/\\])?[^/\\]+)/);
  if (nodeModulesMatch?.[1]) {
    // Normalize path separators and return with scope
    return nodeModulesMatch[1].replace(/\\/g, '/');
  }
  
  // Fallback: use parent directory name
  // e.g., /path/to/plugin-dir/src/index.ts → plugin-dir
  const segments = filePath.replace(/\\/g, '/').split('/');
  // Find 'src' segment and use the one before it
  const srcIndex = segments.findIndex(s => s === 'src');
  if (srcIndex > 0 && segments[srcIndex - 1]) {
    return segments[srcIndex - 1] as string;
  }
  
  // Last fallback: use second-to-last segment
  const fallback = segments[segments.length - 2];
  return fallback ?? path.basename(filePath);
}
