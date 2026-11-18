/**
 * Extension utilities — extracting extension names from settings.json
 * and managing single-file extensions.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

interface SettingsConfig {
  packages?: Array<string | { source: string; extensions?: string[]; skills?: string[] }>;
  extensions?: Array<string | { name?: string; path: string; description?: string }>;
}

/**
 * Extract extension names from settings.json packages + extensions arrays.
 * Used for agent config filtering (which extensions to enable).
 */
export function extractExtensionNames(settings: SettingsConfig): string[] {
  const names: string[] = [];

  // From packages array
  if (settings.packages) {
    for (const pkg of settings.packages) {
      if (!pkg) continue;
      const source = typeof pkg === 'string' ? pkg : pkg.source;
      names.push(extractNameFromSource(source));
    }
  }

  // From extensions array
  if (settings.extensions) {
    for (const ext of settings.extensions) {
      if (!ext) continue;
      if (typeof ext === 'string') {
        // String path: extract filename without extension
        names.push(path.basename(ext, path.extname(ext)));
      } else if (ext.name) {
        // Object with explicit name
        names.push(ext.name);
      } else if (ext.path) {
        // Object with path, extract filename
        names.push(path.basename(ext.path, path.extname(ext.path)));
      }
    }
  }

  return [...new Set(names)]; // Dedupe
}

/**
 * Extract a human-readable name from a package source string.
 * - "npm:pi-mcp-adapter" → "pi-mcp-adapter"
 * - "git:github.com/user/repo@v1" → "repo"
 * - "/path/to/local-pkg" → "local-pkg"
 */
function extractNameFromSource(source: string): string {
  if (source.startsWith('npm:')) {
    return source.slice(4);
  }
  if (source.startsWith('git:')) {
    const repoPath = source.slice(4).split('@')[0] ?? '';
    return path.basename(repoPath);
  }
  // Local path
  return path.basename(source);
}

/**
 * Read settings.json from the given agent directory.
 */
export async function readSettings(agentDir: string): Promise<SettingsConfig> {
  const settingsPath = path.join(agentDir, 'settings.json');
  if (!existsSync(settingsPath)) return {};
  const content = await fs.readFile(settingsPath, 'utf-8');
  return JSON.parse(content) as SettingsConfig;
}

/**
 * Write settings.json to the given agent directory.
 */
export async function writeSettings(agentDir: string, settings: SettingsConfig): Promise<void> {
  const settingsPath = path.join(agentDir, 'settings.json');
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Get the server extensions directory (~/.pi/server/extensions/).
 */
export function getServerExtensionsDir(agentDir: string): string {
  // agentDir is ~/.pi/agent, so server extensions go to ~/.pi/server/extensions
  const piDir = path.dirname(agentDir);
  return path.join(piDir, 'server', 'extensions');
}

/**
 * Upload a single-file extension to the server extensions directory
 * and register it in settings.json.
 */
export async function uploadSingleExtension(
  agentDir: string,
  fileName: string,
  content: string,
): Promise<{ name: string; filePath: string }> {
  const extDir = getServerExtensionsDir(agentDir);
  await fs.mkdir(extDir, { recursive: true });

  // Write the file
  const filePath = path.join(extDir, fileName);
  await fs.writeFile(filePath, content, 'utf-8');

  // Register in settings.json
  const settings = await readSettings(agentDir);
  settings.extensions = settings.extensions ?? [];
  settings.extensions.push(filePath);
  await writeSettings(agentDir, settings);

  // Return the name (filename without extension)
  const name = path.basename(fileName, path.extname(fileName));
  return { name, filePath };
}
