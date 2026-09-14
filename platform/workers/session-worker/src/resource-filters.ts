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
 */
export function createExtensionsFilter(
  allowedExtensions?: string[],
  cwd?: string,
): (base: LoadExtensionsResult) => LoadExtensionsResult {
  return (base) => {
    // No filter configured — allow all
    if (allowedExtensions === null || allowedExtensions === undefined) {
      return base;
    }

    // Empty array — no extensions allowed (but project-local still kept)
    if (allowedExtensions.length === 0) {
      if (!cwd) return { ...base, extensions: [] };
      const projectPrefix = buildProjectExtDirPrefix(cwd);
      return { ...base, extensions: base.extensions.filter((ext) => isProjectLocal(ext.resolvedPath, projectPrefix)) };
    }

    const allowedSet = new Set(allowedExtensions.map((n) => n.toLowerCase()));
    const projectPrefix = cwd ? buildProjectExtDirPrefix(cwd) : null;

    const filtered = base.extensions.filter((ext) => {
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
export function createSkillsFilter(
  allowedSkills?: string[],
): (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  return (base) => {
    // No filter configured — allow all
    if (allowedSkills === null || allowedSkills === undefined) {
      return base;
    }

    // Empty array — no skills allowed (but project-local still kept)
    if (allowedSkills.length === 0) {
      return { ...base, skills: base.skills.filter((s) => s.sourceInfo?.scope === 'project') };
    }

    const allowedSet = new Set(allowedSkills.map((n) => n.toLowerCase()));

    const filtered = base.skills.filter((skill) => {
      // Project-local skills: always keep
      if (skill.sourceInfo?.scope === 'project') return true;
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
 */
export function createPromptsFilter(
  allowedPrompts?: string[],
): (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
  return (base) => {
    // No filter configured — allow all
    if (allowedPrompts === null || allowedPrompts === undefined) {
      return base;
    }

    // Empty array — no prompts allowed (but project-local still kept)
    if (allowedPrompts.length === 0) {
      return { ...base, prompts: base.prompts.filter((p) => p.sourceInfo?.scope === 'project') };
    }

    const allowedSet = new Set(allowedPrompts.map((n) => n.toLowerCase()));

    const filtered = base.prompts.filter((prompt) => {
      // Project-local prompts: always keep
      if (prompt.sourceInfo?.scope === 'project') return true;
      // Global / other prompts: whitelist filter
      return allowedSet.has(prompt.name.toLowerCase());
    });

    return { ...base, prompts: filtered };
  };
}

/**
 * Extract extension name from a file path or source string.
 * - "/path/to/node_modules/pi-mcp-adapter/index.ts" → "pi-mcp-adapter"
 * - "/path/to/plugin-dir/src/index.ts" → "plugin-dir"
 * - "npm:pi-mcp-adapter" → "pi-mcp-adapter"
 */
export function extractExtensionName(filePath: string): string {
  // Handle npm packages
  if (filePath.startsWith('npm:')) {
    return filePath.slice(4);
  }
  
  // Handle git sources
  if (filePath.startsWith('git:')) {
    const repoPath = filePath.slice(4).split('@')[0] ?? '';
    return path.basename(repoPath);
  }
  
  // Handle file paths - try to extract from node_modules structure first
  // e.g., /path/to/node_modules/@scope/pkg-name/src/index.ts → pkg-name
  const nodeModulesMatch = filePath.match(/node_modules[/\\](?:@[^/\\]+[/\\])?([^/\\]+)/);
  if (nodeModulesMatch?.[1]) {
    return nodeModulesMatch[1];
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
