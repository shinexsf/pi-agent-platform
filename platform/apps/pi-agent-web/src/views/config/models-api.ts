/**
 * models-api — `/api/config/models` 的数据类型与读写封装。
 *
 * 拆出来是因为 `ModelsConfig.vue`（列表）与 `ProviderEditorView.vue`（路由页表单）
 * 需要共享同一套 Provider 结构与读写逻辑。
 */

export interface BuiltinProvider {
  id: string;
  name: string;
  api: string;
}

export interface ProviderModel {
  id: string;
  name: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface ProviderConfig {
  name?: string;
  baseUrl: string;
  apiKey: string;
  api: string;
  compat?: Record<string, unknown>;
  models?: ProviderModel[];
}

export interface ModelsData {
  providers: Record<string, ProviderConfig>;
  auth: Record<string, { type: string; key: string }>;
}

export const API_TYPES = [
  { value: 'openai-completions', label: 'OpenAI Completions (兼容)' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
  { value: 'google-generative-ai', label: 'Google Generative AI' },
  { value: 'google-vertex', label: 'Google Vertex' },
  { value: 'mistral-conversations', label: 'Mistral Conversations' },
  { value: 'bedrock-converse-stream', label: 'AWS Bedrock' },
  { value: 'azure-openai-responses', label: 'Azure OpenAI' },
] as const;

export function emptyProvider(): ProviderConfig {
  return {
    baseUrl: '',
    apiKey: '',
    api: 'openai-completions',
    models: [],
  };
}

export function emptyModel(): ProviderModel {
  return {
    id: '',
    name: '',
    reasoning: false,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchModelsData(): Promise<ModelsData> {
  return readJson<ModelsData>(await fetch('/api/config/models'));
}

export async function fetchBuiltinProviders(): Promise<BuiltinProvider[]> {
  return readJson<BuiltinProvider[]>(await fetch('/api/config/builtin-providers'));
}

/** PUT /api/config/models —— 可只带 providers / auth / builtinProvider 之一。 */
export async function putModels(
  patch: Partial<ModelsData> & { builtinProvider?: { name: string; apiKey: string } },
): Promise<void> {
  const res = await fetch('/api/config/models', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export interface TestResult {
  ok: boolean;
  message: string;
}

export async function testProviderConnection(
  providerName: string,
  provider: ProviderConfig,
): Promise<TestResult> {
  const res = await fetch('/api/config/models/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: providerName,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as TestResult;
}

/** 校验 Provider 表单，返回错误信息（null 表示通过）。 */
export function validateProvider(name: string, provider: ProviderConfig): string | null {
  if (!name.trim()) return '请填写 Provider 名称';
  if (!provider.baseUrl || !provider.apiKey || !provider.api) {
    return '请填写必填字段：API 地址、API 密钥、接口格式';
  }
  for (const model of provider.models ?? []) {
    if (!model.id || !model.name || !model.contextWindow || !model.maxTokens) {
      return '模型配置不完整：请填写模型 ID、名称、上下文窗口、最大输出';
    }
  }
  return null;
}
