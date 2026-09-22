/**
 * Server-side Model Registry wrapper.
 *
 * Wraps pi SDK `ModelRuntime` + `ModelRegistry` to provide:
 * - Lazy async initialization (don't block server startup)
 * - Cached list of available models (refreshed on demand)
 * - Graceful fallback when pi SDK init fails (return empty list, banner warns)
 *
 * Why server has its own ModelRegistry (R9 mitigation):
 *   - Worker is per-session; no global worker to query for model list
 *   - Server `/api/models` endpoint must serve all sessions globally
 *   - Accepting the dep cost is simpler than spawning temp discovery workers
 */

import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { childLogger } from './logger.js';

const logger = childLogger('model-registry');

export interface ModelInfo {
  provider: string;
  modelId: string;
  displayName: string;
  hasAuth: boolean;
}

let cachedRegistry: ModelRegistry | null = null;
let cachedModels: ModelInfo[] | null = null;
let initFailed = false;

/**
 * Initialize ModelRegistry. Returns cached instance if already initialized.
 * On failure, logs error and throws (caller can choose to continue with empty list).
 */
export async function initModelRegistry(): Promise<ModelRegistry> {
  if (cachedRegistry) return cachedRegistry;
  if (initFailed) {
    throw new Error('ModelRegistry previously failed to initialize');
  }
  const runtime = await ModelRuntime.create({});
  const registry = new ModelRegistry(runtime);
  cachedRegistry = registry;
  cachedModels = null; // invalidate cache
  return registry;
}

/**
 * List available models. Lazily initializes registry on first call.
 * Returns empty list if initialization failed.
 */
export async function listAvailableModels(): Promise<ModelInfo[]> {
  if (cachedModels) return cachedModels;
  try {
    const registry = await initModelRegistry();
    const models = registry.getAvailable();
    cachedModels = models.map((m) => ({
      provider: m.provider,
      modelId: m.id,
      displayName: m.name || `${m.provider}/${m.id}`,
      hasAuth: registry.hasConfiguredAuth(m),
    }));
    return cachedModels;
  } catch (err) {
    initFailed = true;
    logger.error({ err }, 'listAvailableModels failed');
    return [];
  }
}

/**
 * Reset cached state (for tests).
 */
export function resetModelRegistry(): void {
  cachedRegistry = null;
  cachedModels = null;
  initFailed = false;
}
