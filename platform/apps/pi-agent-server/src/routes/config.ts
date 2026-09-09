/**
 * Configuration management routes.
 *
 * Provides REST API for managing pi agent global configuration:
 * - Model providers and API keys
 * - Default settings (model, thinking level)
 * - Skills management
 * - Prompts management
 * - Extensions management
 */

import { Hono } from 'hono';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync, spawn } from 'node:child_process';
import type { ServerConfig } from '../config.js';

// Types
interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  api?: string;
  compat?: Record<string, unknown>;
  models?: Array<{
    id: string;
    name: string;
    reasoning?: boolean;
    input?: string[];
    contextWindow?: number;
    maxTokens?: number;
  }>;
}

interface ModelsConfig {
  providers: Record<string, ProviderConfig>;
}

interface AuthConfig {
  [provider: string]: {
    type: string;
    key: string;
  };
}

interface SettingsConfig {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  enabledModels?: string[];
  packages?: Array<string | { source: string; extensions?: string[]; skills?: string[]; prompts?: string[] }>;
  extensions?: string[];
  [key: string]: unknown;
}

interface SkillInfo {
  name: string;
  filePath: string;
  baseDir: string;
  hasFrontmatter: boolean;
}

interface PromptInfo {
  name: string;
  filePath: string;
  baseDir: string;
  hasFrontmatter: boolean;
}

interface ExtensionInfo {
  name: string;
  source: 'npm' | 'git' | 'local' | 'builtin';
  path: string;
  enabled: boolean;
}

function defaultAgentDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? process.env.HOMEPATH ?? '.';
  const sep = home.includes('\\') ? '\\' : '/';
  return `${home}${sep}.pi${sep}agent`;
}

function stripFrontmatter(raw: string): string {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? raw.slice(m[0].length).trim() : raw.trim();
}

function hasFrontmatter(raw: string): boolean {
  return /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.test(raw);
}

export function createConfigRouter(config: ServerConfig) {
  const router = new Hono();
  const agentDir = config.agentDir ?? defaultAgentDir();

  // Helper: read JSON file
  async function readJson<T>(filePath: string): Promise<T | null> {
    try {
      if (!existsSync(filePath)) return null;
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  // Helper: write JSON file
  async function writeJson(filePath: string, data: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  // Helper: list directory entries
  async function listDir(dirPath: string, ext?: string): Promise<string[]> {
    try {
      if (!existsSync(dirPath)) return [];
      const entries = await fs.readdir(dirPath);
      if (ext) {
        return entries.filter((e) => e.endsWith(ext));
      }
      return entries;
    } catch {
      return [];
    }
  }

  // Helper: execute pi CLI command
  function execPi(args: string[]): { stdout: string; stderr: string; success: boolean } {
    try {
      const stdout = execSync(`pi ${args.join(' ')}`, {
        encoding: 'utf-8',
        timeout: 60000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { stdout, stderr: '', success: true };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? 'Unknown error',
        success: false,
      };
    }
  }

  // ========== Models ==========

  // GET /api/config/builtin-providers
  router.get('/builtin-providers', async (c) => {
    // 返回内置 provider 列表（静态配置）
    const builtinProviders = [
      { id: 'anthropic', name: 'Anthropic', api: 'anthropic-messages' },
      { id: 'openai', name: 'OpenAI', api: 'openai-completions' },
      { id: 'deepseek', name: 'DeepSeek', api: 'openai-completions' },
      { id: 'google', name: 'Google Gemini', api: 'google-generative-ai' },
      { id: 'google-vertex', name: 'Google Vertex', api: 'google-vertex' },
      { id: 'xai', name: 'xAI (Grok)', api: 'openai-completions' },
      { id: 'mistral', name: 'Mistral', api: 'mistral-conversations' },
      { id: 'groq', name: 'Groq', api: 'openai-completions' },
      { id: 'openrouter', name: 'OpenRouter', api: 'openai-completions' },
      { id: 'amazon-bedrock', name: 'Amazon Bedrock', api: 'bedrock-converse-stream' },
      { id: 'azure-openai-responses', name: 'Azure OpenAI', api: 'azure-openai-responses' },
      { id: 'minimax', name: 'MiniMax', api: 'openai-completions' },
      { id: 'minimax-cn', name: 'MiniMax (China)', api: 'openai-completions' },
      { id: 'moonshotai', name: 'Moonshot AI', api: 'openai-completions' },
      { id: 'nvidia', name: 'NVIDIA NIM', api: 'openai-completions' },
      { id: 'together', name: 'Together AI', api: 'openai-completions' },
      { id: 'fireworks', name: 'Fireworks', api: 'openai-completions' },
      { id: 'cerebras', name: 'Cerebras', api: 'openai-completions' },
      { id: 'huggingface', name: 'Hugging Face', api: 'openai-completions' },
      { id: 'xiaomi', name: 'Xiaomi MiMo', api: 'openai-completions' },
      { id: 'xiaomi-token-plan-cn', name: 'Xiaomi Token Plan (China)', api: 'openai-completions' },
      { id: 'zai', name: 'ZAI', api: 'openai-completions' },
    ];
    return c.json(builtinProviders);
  });

  // GET /api/config/models
  router.get('/models', async (c) => {
    const modelsPath = path.join(agentDir, 'models.json');
    const authPath = path.join(agentDir, 'auth.json');

    const models = await readJson<ModelsConfig>(modelsPath);
    const auth = await readJson<AuthConfig>(authPath);

    return c.json({
      providers: models?.providers ?? {},
      auth: auth ?? {},
    });
  });

  // PUT /api/config/models
  router.put('/models', async (c) => {
    const body = (await c.req.json()) as {
      providers?: ModelsConfig['providers'];
      auth?: AuthConfig;
      // 单个 provider 快速更新（有供应商模式）
      builtinProvider?: {
        name: string;
        apiKey: string;
      };
    };

    // 有供应商模式：只更新 auth.json
    if (body.builtinProvider) {
      const authPath = path.join(agentDir, 'auth.json');
      const auth = await readJson<AuthConfig>(authPath) ?? {};
      auth[body.builtinProvider.name] = {
        type: 'api_key',
        key: body.builtinProvider.apiKey,
      };
      await writeJson(authPath, auth);
      return c.json({ ok: true });
    }

    // 自定义模式：更新 models.json 和 auth.json
    if (body.providers !== undefined) {
      const modelsPath = path.join(agentDir, 'models.json');
      await writeJson(modelsPath, { providers: body.providers });
    }

    if (body.auth !== undefined) {
      const authPath = path.join(agentDir, 'auth.json');
      await writeJson(authPath, body.auth);
    }

    return c.json({ ok: true });
  });

  // POST /api/config/models/test
  router.post('/models/test', async (c) => {
    const body = (await c.req.json()) as { provider: string; baseUrl: string; apiKey: string };

    try {
      // Simple connection test: try to fetch models endpoint
      const url = `${body.baseUrl}/models`;
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${body.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        return c.json({ ok: true, message: 'Connection successful' });
      } else {
        return c.json({ ok: false, message: `HTTP ${response.status}: ${response.statusText}` });
      }
    } catch (err) {
      return c.json({ ok: false, message: (err as Error).message });
    }
  });

  // ========== Settings ==========

  // GET /api/config/settings
  router.get('/settings', async (c) => {
    const settingsPath = path.join(agentDir, 'settings.json');
    const settings = await readJson<SettingsConfig>(settingsPath);
    return c.json(settings ?? {});
  });

  // PUT /api/config/settings
  router.put('/settings', async (c) => {
    const body = (await c.req.json()) as SettingsConfig;
    const settingsPath = path.join(agentDir, 'settings.json');

    // Merge with existing settings
    const existing = await readJson<SettingsConfig>(settingsPath) ?? {};
    const merged = { ...existing, ...body };

    await writeJson(settingsPath, merged);
    return c.json({ ok: true });
  });

  // ========== Skills ==========

  // GET /api/config/skills
  router.get('/skills', async (c) => {
    const skillsDir = path.join(agentDir, 'skills');
    const entries = await listDir(skillsDir);

    const skills: SkillInfo[] = [];
    for (const entry of entries) {
      const entryPath = path.join(skillsDir, entry);
      const stat = await fs.stat(entryPath);

      if (stat.isDirectory()) {
        // Directory-based skill: look for SKILL.md
        const skillFile = path.join(entryPath, 'SKILL.md');
        if (existsSync(skillFile)) {
          const content = await fs.readFile(skillFile, 'utf-8');
          skills.push({
            name: entry,
            filePath: skillFile,
            baseDir: entryPath,
            hasFrontmatter: hasFrontmatter(content),
          });
        }
      } else if (entry.endsWith('.md')) {
        // Single file skill
        const name = entry.replace(/\.md$/, '');
        skills.push({
          name,
          filePath: entryPath,
          baseDir: skillsDir,
          hasFrontmatter: hasFrontmatter(await fs.readFile(entryPath, 'utf-8')),
        });
      }
    }

    return c.json(skills);
  });

  // GET /api/config/skills/:name
  router.get('/skills/:name', async (c) => {
    const name = c.req.param('name');
    const skillsDir = path.join(agentDir, 'skills');

    // Try directory first
    const dirPath = path.join(skillsDir, name, 'SKILL.md');
    if (existsSync(dirPath)) {
      const content = await fs.readFile(dirPath, 'utf-8');
      return c.json({ name, content, filePath: dirPath });
    }

    // Try single file
    const filePath = path.join(skillsDir, `${name}.md`);
    if (existsSync(filePath)) {
      const content = await fs.readFile(filePath, 'utf-8');
      return c.json({ name, content, filePath });
    }

    return c.json({ error: 'Skill not found' }, 404);
  });

  // PUT /api/config/skills/:name
  router.put('/skills/:name', async (c) => {
    const name = c.req.param('name');
    const body = (await c.req.json()) as { content: string };
    const skillsDir = path.join(agentDir, 'skills');

    // Try directory first
    const dirPath = path.join(skillsDir, name, 'SKILL.md');
    if (existsSync(dirPath)) {
      await fs.writeFile(dirPath, body.content, 'utf-8');
      return c.json({ ok: true });
    }

    // Try single file
    const filePath = path.join(skillsDir, `${name}.md`);
    if (existsSync(filePath)) {
      await fs.writeFile(filePath, body.content, 'utf-8');
      return c.json({ ok: true });
    }

    return c.json({ error: 'Skill not found' }, 404);
  });

  // POST /api/config/skills
  router.post('/skills', async (c) => {
    const body = (await c.req.json()) as { name: string; content: string };
    const skillsDir = path.join(agentDir, 'skills');

    // Validate name
    if (!body.name || !/^[a-zA-Z0-9_-]+$/.test(body.name)) {
      return c.json({ error: 'Invalid skill name (use alphanumeric, hyphens, underscores)' }, 400);
    }

    const filePath = path.join(skillsDir, `${body.name}.md`);

    if (existsSync(filePath)) {
      return c.json({ error: 'Skill already exists' }, 409);
    }

    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(filePath, body.content, 'utf-8');
    return c.json({ ok: true, filePath }, 201);
  });

  // DELETE /api/config/skills/:name
  router.delete('/skills/:name', async (c) => {
    const name = c.req.param('name');
    const skillsDir = path.join(agentDir, 'skills');

    // Try directory first
    const dirPath = path.join(skillsDir, name);
    if (existsSync(dirPath)) {
      const stat = await fs.stat(dirPath);
      if (stat.isDirectory()) {
        await fs.rm(dirPath, { recursive: true, force: true });
        return c.json({ ok: true });
      }
    }

    // Try single file
    const filePath = path.join(skillsDir, `${name}.md`);
    if (existsSync(filePath)) {
      await fs.unlink(filePath);
      return c.json({ ok: true });
    }

    return c.json({ error: 'Skill not found' }, 404);
  });

  // POST /api/config/skills/upload
  router.post('/skills/upload', async (c) => {
    // Handle file upload - expect FormData with file
    const body = await c.req.parseBody();
    const file = body['file'];

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No file uploaded' }, 400);
    }

    if (!file.name.endsWith('.md')) {
      return c.json({ error: 'Only .md files are allowed' }, 400);
    }

    const content = await file.text();
    const name = file.name.replace(/\.md$/, '');
    const skillsDir = path.join(agentDir, 'skills');
    const filePath = path.join(skillsDir, `${name}.md`);

    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');

    return c.json({ ok: true, name, filePath }, 201);
  });

  // ========== Prompts ==========

  // GET /api/config/prompts
  router.get('/prompts', async (c) => {
    const promptsDir = path.join(agentDir, 'prompts');
    const entries = await listDir(promptsDir, '.md');

    const prompts: PromptInfo[] = [];
    for (const entry of entries) {
      const filePath = path.join(promptsDir, entry);
      const name = entry.replace(/\.md$/, '');
      const content = await fs.readFile(filePath, 'utf-8');
      prompts.push({
        name,
        filePath,
        baseDir: promptsDir,
        hasFrontmatter: hasFrontmatter(content),
      });
    }

    return c.json(prompts);
  });

  // GET /api/config/prompts/:name
  router.get('/prompts/:name', async (c) => {
    const name = c.req.param('name');
    const promptsDir = path.join(agentDir, 'prompts');
    const filePath = path.join(promptsDir, `${name}.md`);

    if (!existsSync(filePath)) {
      return c.json({ error: 'Prompt not found' }, 404);
    }

    const content = await fs.readFile(filePath, 'utf-8');
    return c.json({ name, content, filePath });
  });

  // PUT /api/config/prompts/:name
  router.put('/prompts/:name', async (c) => {
    const name = c.req.param('name');
    const body = (await c.req.json()) as { content: string };
    const promptsDir = path.join(agentDir, 'prompts');
    const filePath = path.join(promptsDir, `${name}.md`);

    if (!existsSync(filePath)) {
      return c.json({ error: 'Prompt not found' }, 404);
    }

    await fs.writeFile(filePath, body.content, 'utf-8');
    return c.json({ ok: true });
  });

  // POST /api/config/prompts
  router.post('/prompts', async (c) => {
    const body = (await c.req.json()) as { name: string; content: string };
    const promptsDir = path.join(agentDir, 'prompts');

    // Validate name
    if (!body.name || !/^[a-zA-Z0-9_-]+$/.test(body.name)) {
      return c.json({ error: 'Invalid prompt name (use alphanumeric, hyphens, underscores)' }, 400);
    }

    const filePath = path.join(promptsDir, `${body.name}.md`);

    if (existsSync(filePath)) {
      return c.json({ error: 'Prompt already exists' }, 409);
    }

    await fs.mkdir(promptsDir, { recursive: true });
    await fs.writeFile(filePath, body.content, 'utf-8');
    return c.json({ ok: true, filePath }, 201);
  });

  // DELETE /api/config/prompts/:name
  router.delete('/prompts/:name', async (c) => {
    const name = c.req.param('name');
    const promptsDir = path.join(agentDir, 'prompts');
    const filePath = path.join(promptsDir, `${name}.md`);

    if (!existsSync(filePath)) {
      return c.json({ error: 'Prompt not found' }, 404);
    }

    await fs.unlink(filePath);
    return c.json({ ok: true });
  });

  // ========== Extensions ==========

  // GET /api/config/extensions
  router.get('/extensions', async (c) => {
    const settingsPath = path.join(agentDir, 'settings.json');
    const settings = await readJson<SettingsConfig>(settingsPath);

    const extensions: ExtensionInfo[] = [];

    // From settings.packages
    if (settings?.packages) {
      for (const pkg of settings.packages) {
        if (!pkg) continue;
        const source = typeof pkg === 'string' ? pkg : pkg.source;
        let name: string;
        let type: 'npm' | 'git' | 'local';

        if (source.startsWith('npm:')) {
          name = source.slice(4);
          type = 'npm';
        } else if (source.startsWith('git:')) {
          name = source.slice(4).split('@')[0] ?? path.basename(source);
          type = 'git';
        } else {
          name = path.basename(source);
          type = 'local';
        }

        extensions.push({
          name,
          source: type,
          path: source,
          enabled: true,
        });
      }
    }

    // From extensions directory
    const extensionsDir = path.join(agentDir, 'extensions');
    const entries = await listDir(extensionsDir);
    for (const entry of entries) {
      // Skip package.json
      if (entry === 'package.json') continue;

      const entryPath = path.join(extensionsDir, entry);
      const stat = await fs.stat(entryPath);

      if (stat.isFile() && (entry.endsWith('.ts') || entry.endsWith('.js'))) {
        extensions.push({
          name: entry.replace(/\.(ts|js)$/, ''),
          source: 'local',
          path: entryPath,
          enabled: true,
        });
      } else if (stat.isDirectory()) {
        extensions.push({
          name: entry,
          source: 'local',
          path: entryPath,
          enabled: true,
        });
      }
    }

    return c.json(extensions);
  });

  // POST /api/config/extensions/install-by-url
  router.post('/extensions/install-by-url', async (c) => {
    const body = (await c.req.json()) as { source: string };

    if (!body.source) {
      return c.json({ error: 'Source is required' }, 400);
    }

    // Validate source format
    const validPrefixes = ['npm:', 'git:', 'http://', 'https://', 'ssh://'];
    if (!validPrefixes.some((p) => body.source.startsWith(p))) {
      return c.json({ error: 'Invalid source format. Use npm:, git:, http://, https://, or ssh://' }, 400);
    }

    const result = execPi(['install', body.source]);
    if (result.success) {
      return c.json({ ok: true, message: result.stdout });
    } else {
      return c.json({ ok: false, message: result.stderr }, 500);
    }
  });

  // POST /api/config/extensions/upload-single
  router.post('/extensions/upload-single', async (c) => {
    const body = await c.req.parseBody();
    const file = body['file'];

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No file uploaded' }, 400);
    }

    if (!file.name.endsWith('.ts') && !file.name.endsWith('.js')) {
      return c.json({ error: 'Only .ts and .js files are allowed' }, 400);
    }

    // 1MB limit
    if (file.size > 1 * 1024 * 1024) {
      return c.json({ error: 'File size exceeds 1MB limit' }, 400);
    }

    const content = await file.text();
    const extensionsDir = path.join(agentDir, 'extensions');
    const filePath = path.join(extensionsDir, file.name);

    await fs.mkdir(extensionsDir, { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');

    return c.json({ ok: true, name: file.name.replace(/\.(ts|js)$/, ''), filePath }, 201);
  });

  // POST /api/config/extensions/upload-zip
  router.post('/extensions/upload-zip', async (c) => {
    const body = await c.req.parseBody();
    const file = body['file'];

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No file uploaded' }, 400);
    }

    if (!file.name.endsWith('.zip')) {
      return c.json({ error: 'Only .zip files are allowed' }, 400);
    }

    // 10MB limit
    if (file.size > 10 * 1024 * 1024) {
      return c.json({ error: 'File size exceeds 10MB limit' }, 400);
    }

    try {
      // Create uploads directory
      const home = process.env.HOME ?? process.env.USERPROFILE ?? process.env.HOMEPATH ?? '.';
      const sep = home.includes('\\') ? '\\' : '/';
      const uploadsDir = `${home}${sep}.pi${sep}server${sep}uploads${sep}extensions`;
      await fs.mkdir(uploadsDir, { recursive: true });

      // Save zip file temporarily
      const zipPath = path.join(uploadsDir, file.name);
      const arrayBuffer = await file.arrayBuffer();
      await fs.writeFile(zipPath, Buffer.from(arrayBuffer));

      // Extract zip
      const dirName = file.name.replace(/\.zip$/, '');
      const extractDir = path.join(uploadsDir, dirName);
      await fs.mkdir(extractDir, { recursive: true });

      // Use system unzip command
      execSync(`unzip -o "${zipPath}" -d "${extractDir}"`, { stdio: 'pipe' });

      // Clean up zip file
      await fs.unlink(zipPath);

      // Install via pi CLI
      const result = execPi(['install', extractDir]);
      if (result.success) {
        return c.json({ ok: true, message: result.stdout, path: extractDir });
      } else {
        return c.json({ ok: false, message: result.stderr }, 500);
      }
    } catch (err) {
      return c.json({ ok: false, message: (err as Error).message }, 500);
    }
  });

  // DELETE /api/config/extensions/:name
  router.delete('/extensions/:name', async (c) => {
    const name = c.req.param('name');

    // Try to find and remove from packages first
    const settingsPath = path.join(agentDir, 'settings.json');
    const settings = await readJson<SettingsConfig>(settingsPath);

    if (settings?.packages) {
      const pkgIndex = settings.packages.findIndex((pkg) => {
        const source = typeof pkg === 'string' ? pkg : pkg.source;
        return source.includes(name);
      });

      if (pkgIndex !== -1) {
        const pkg = settings.packages[pkgIndex];
        if (!pkg) return c.json({ error: 'Extension not found' }, 404);
        const source = typeof pkg === 'string' ? pkg : pkg.source;

        // npm or git package: use pi remove CLI
        if (source.startsWith('npm:') || source.startsWith('git:')) {
          const result = execPi(['remove', source]);
          if (result.success) {
            return c.json({ ok: true, message: result.stdout });
          } else {
            return c.json({ ok: false, message: result.stderr }, 500);
          }
        }

        // Local path: remove from packages array in settings.json
        const newPackages = settings.packages.filter((_, i) => i !== pkgIndex);
        const updatedSettings = { ...settings, packages: newPackages };
        await writeJson(settingsPath, updatedSettings);
        return c.json({ ok: true, message: `Removed ${name} from packages` });
      }
    }

    // Try to remove from extensions directory
    const extensionsDir = path.join(agentDir, 'extensions');
    const candidates = [
      path.join(extensionsDir, `${name}.ts`),
      path.join(extensionsDir, `${name}.js`),
      path.join(extensionsDir, name),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        const stat = await fs.stat(candidate);
        if (stat.isDirectory()) {
          await fs.rm(candidate, { recursive: true, force: true });
        } else {
          await fs.unlink(candidate);
        }
        return c.json({ ok: true });
      }
    }

    return c.json({ error: 'Extension not found' }, 404);
  });

  return router;
}
