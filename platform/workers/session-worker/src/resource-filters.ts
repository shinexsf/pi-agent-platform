/**
 * Resource filter functions for agent config.
 * These functions are used as Override callbacks for DefaultResourceLoader.
 */

import path from 'node:path';
import type { LoadExtensionsResult, Skill, ResourceDiagnostic } from '@earendil-works/pi-coding-agent';
import type { PromptTemplate } from '@earendil-works/pi-coding-agent';

/**
 * Filter extensions based on agent config.extensions whitelist.
 * If extensions is null/undefined, all extensions are allowed.
 * If extensions is empty array, no extensions are allowed.
 */
export function createExtensionsFilter(
  allowedExtensions?: string[],
): (base: LoadExtensionsResult) => LoadExtensionsResult {
  return (base) => {
    // No filter configured — allow all
    if (allowedExtensions === null || allowedExtensions === undefined) {
      return base;
    }

    // Empty array — no extensions allowed
    if (allowedExtensions.length === 0) {
      return { ...base, extensions: [] };
    }

    const allowedSet = new Set(allowedExtensions.map((n) => n.toLowerCase()));
    
    // Filter extensions by name (try both path and resolvedPath)
    const filtered = base.extensions.filter((ext) => {
      const name = extractExtensionName(ext.path);
      const resolvedName = extractExtensionName(ext.resolvedPath);
      return allowedSet.has(name.toLowerCase()) || allowedSet.has(resolvedName.toLowerCase());
    });

    return { ...base, extensions: filtered };
  };
}

/**
 * Filter skills based on agent config.skills whitelist.
 * If skills is null/undefined, all skills are allowed.
 * If skills is empty array, no skills are allowed.
 */
export function createSkillsFilter(
  allowedSkills?: string[],
): (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
  return (base) => {
    // No filter configured — allow all
    if (allowedSkills === null || allowedSkills === undefined) {
      return base;
    }

    // Empty array — no skills allowed
    if (allowedSkills.length === 0) {
      return { ...base, skills: [] };
    }

    const allowedSet = new Set(allowedSkills.map((n) => n.toLowerCase()));
    
    const filtered = base.skills.filter((skill) => {
      return allowedSet.has(skill.name.toLowerCase());
    });

    return { ...base, skills: filtered };
  };
}

/**
 * Filter prompts based on agent config.prompts whitelist.
 * If prompts is null/undefined, all prompts are allowed.
 * If prompts is empty array, no prompts are allowed.
 */
export function createPromptsFilter(
  allowedPrompts?: string[],
): (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
  return (base) => {
    // No filter configured — allow all
    if (allowedPrompts === null || allowedPrompts === undefined) {
      return base;
    }

    // Empty array — no prompts allowed
    if (allowedPrompts.length === 0) {
      return { ...base, prompts: [] };
    }

    const allowedSet = new Set(allowedPrompts.map((n) => n.toLowerCase()));
    
    const filtered = base.prompts.filter((prompt) => {
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
