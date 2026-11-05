/**
 * 工具卡片插件规则（会话级）。
 *
 * 规则来自 `GET /api/sessions/:id/extensions`，不是 `package.json`。
 * 会话切换时刷新；未加载时的行为与没有插件完全一致。
 */

import { shallowRef, type ShallowRef } from 'vue';
import type { WithPlugin } from '@pi-agent-platform/api-types';
import type { ToolCardRegistration } from '@pi-agent-platform/plugin-types';
import { loadSessionExtensions } from '../../../plugins/host';

const rules: ShallowRef<Array<WithPlugin<ToolCardRegistration>>> = shallowRef([]);
let loadedFor: string | undefined;

export const pluginToolCardRules = rules;

export async function refreshToolCardRules(sessionId?: string): Promise<void> {
  loadedFor = sessionId;
  try {
    const body = await loadSessionExtensions(sessionId);
    rules.value = body.toolCards;
  } catch (err) {
    console.warn('[plugin] tool card rules failed', err);
    rules.value = [];
  }
}

/** 当前会话是否已经加载过规则（避免每个卡片各自触发一次拉取）。 */
export function toolCardRulesLoadedFor(): string | undefined {
  return loadedFor;
}

/** 按工具名找规则：精确名优先，其次最长前缀匹配。 */
export function ruleFor(
  tool: string,
  list: Array<WithPlugin<ToolCardRegistration>> = rules.value,
): WithPlugin<ToolCardRegistration> | undefined {
  const exact = list.find((rule) => (rule.match ?? 'exact') === 'exact' && rule.tool === tool);
  if (exact) return exact;
  let best: WithPlugin<ToolCardRegistration> | undefined;
  for (const rule of list) {
    if (rule.match !== 'prefix') continue;
    if (!tool.startsWith(rule.tool)) continue;
    if (!best || rule.tool.length > best.tool.length) best = rule;
  }
  return best;
}
