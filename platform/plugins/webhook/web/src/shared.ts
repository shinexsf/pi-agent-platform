/**
 * webhook UI 的共享小工具（list / editor 共用）。
 *
 * 原生 DOM，因为 web facet 的契约就是 `mount(el, host)` —— 平台给一个挂载点和
 * 一组能力（api / navigate / toast / sheet / theme），不给组件库。
 *
 * 颜色只许用平台承诺的变量（`PLATFORM_THEME_VARS`）。猜变量名不会报错，
 * 只会静默走 fallback —— 表现就是"暗色下这块永远白底"。
 */

import type { PluginWebHost } from '@pi-agent-platform/plugin-types/web';

export interface HookDTO {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  sessionMode: 'new' | 'reuse';
  sessionId: string | null;
  busyPolicy: 'followUp' | 'steer' | 'skip';
  /** 明文（页面固定展示）。 */
  secret: string;
  enabled: boolean;
  deliveriesCount: number;
  lastDeliveredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryDTO {
  id: string;
  status: 'delivered' | 'skipped' | 'failed';
  reason: string | null;
  triggeredBy: string;
  idempotencyKey: string | null;
  payloadBytes: number | null;
  sessionId: string | null;
  receivedAt: number;
  finishedAt: number | null;
}

export interface MetaDTO {
  agents: Array<{ id: string; name: string }>;
  maxBodyBytes: number;
  idempotencyWindowMs: number;
}

/** 极简建 DOM 助手（`on*` 当事件、`text` 当文本、其余当属性）。 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export const fmtTime = (ms: number | null): string => (ms ? new Date(ms).toLocaleString('zh-CN') : '—');

export function fmtBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export const STATUS_LABEL: Record<DeliveryDTO['status'], string> = {
  delivered: '已送达',
  skipped: '已跳过',
  failed: '失败',
};

export const BUSY_LABEL: Record<HookDTO['busyPolicy'], string> = {
  followUp: '排队（followUp）',
  steer: '插队（steer）',
  skip: '跳过（skip）',
};

export function renderState(el: HTMLElement, text: string, kind: 'loading' | 'error' | 'empty' = 'loading'): void {
  el.replaceChildren(h('div', { class: `wh-state wh-state-${kind}`, text }));
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 完整 URL：平台不知道自己的公网地址，用地址栏补全（反代/内网自行替换前缀）。 */
export function originOf(): string {
  try {
    const { origin, pathname } = window.location;
    // 平台可能挂在子路径下（如 `/ide/`）：取 base 之后的公共前缀没有意义，
    // 直接用 origin 即可 —— 子路径部署的例外由用户自己粘贴时修正。
    void pathname;
    return origin;
  } catch {
    return '';
  }
}

/** 把 `host` 的 api 包成带类型的小客户端。 */
export function createClient(host: PluginWebHost) {
  return {
    meta: () => host.api.get('meta') as Promise<MetaDTO>,
    sessions: (agentId: string) =>
      host.api.get(`sessions?agentId=${encodeURIComponent(agentId)}`) as Promise<{
        items: Array<{ id: string; agentId?: string; status: string }>;
      }>,
    list: (includeDisabled: boolean) =>
      host.api.get(`hooks${includeDisabled ? '?includeDisabled=1' : ''}`) as Promise<{ items: HookDTO[] }>,
    get: (id: string) =>
      host.api.get(`hooks/${id}`) as Promise<{ hook: HookDTO; url: string; deliveries: DeliveryDTO[] }>,
    create: (body: Record<string, unknown>) =>
      host.api.post('hooks', body) as Promise<{ hook: HookDTO; url: string }>,
    update: (id: string, body: Record<string, unknown>) =>
      host.api.put(`hooks/${id}`, body) as Promise<{ hook: HookDTO; url: string }>,
    remove: (id: string) => host.api.del(`hooks/${id}`) as Promise<unknown>,
    rotate: (id: string) => host.api.post(`hooks/${id}/rotate-secret`, {}) as Promise<{ secret: string }>,
    run: (id: string, payload: unknown) =>
      host.api.post(`hooks/${id}/run`, { payload }) as Promise<{ status: string; reason?: string }>,
    deliveries: (id: string) =>
      host.api.get(`hooks/${id}/deliveries?limit=50`) as Promise<{ items: DeliveryDTO[] }>,
  };
}

/** 复制到剪贴板（http 环境下 `navigator.clipboard` 不可用时退回 textarea）。 */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export const STYLE_ID = 'wh-style';
export const CSS = `
.wh-root { display: flex; flex-direction: column; gap: 12px; font-size: 13px; }
.wh-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wh-bar h2 { font-size: 15px; font-weight: 600; margin: 0; }
.wh-spacer { flex: 1; }
.wh-btn { border: 1px solid var(--border); background: var(--surface); color: var(--text);
  border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.wh-btn:hover { background: var(--surface-hover); }
.wh-btn-primary { background: var(--accent); border-color: transparent; color: #fff; }
.wh-btn-icon { padding: 2px 6px; }
.wh-table { width: 100%; border-collapse: collapse; }
.wh-table th { text-align: left; font-weight: 500; font-size: 11px; text-transform: uppercase;
  letter-spacing: .04em; color: var(--text-secondary); padding: 6px 8px; border-bottom: 1px solid var(--border); }
.wh-table td { padding: 8px; border-bottom: 1px solid var(--border-subtle); vertical-align: top; }
.wh-name { font-weight: 500; }
.wh-sub { color: var(--text-secondary); font-size: 11px; }
.wh-mono { font-family: var(--font-mono); font-size: 11px; word-break: break-all; }
.wh-pill { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 11px; }
.wh-pill-on { background: var(--success-soft); color: var(--success); }
.wh-pill-off { background: var(--surface-subtle); color: var(--text-secondary); }
.wh-pill-fail { background: var(--danger-soft); color: var(--danger); }
.wh-state { padding: 24px; text-align: center; color: var(--text-secondary); }
.wh-state-error { color: var(--danger); }
.wh-empty { padding: 40px; text-align: center; color: var(--text-secondary); }
.wh-field { display: flex; flex-direction: column; gap: 4px; }
.wh-field > label { font-size: 12px; color: var(--text-secondary); }
.wh-field input, .wh-field select, .wh-field textarea { background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; font-size: 13px; font-family: inherit; }
.wh-field textarea { min-height: 96px; resize: vertical; }
.wh-row { display: flex; gap: 12px; flex-wrap: wrap; }
.wh-row > * { flex: 1 1 220px; }
.wh-hint { font-size: 11px; color: var(--text-tertiary); }
.wh-card { border: 1px solid var(--border); border-radius: 8px; padding: 12px; background: var(--surface); }
.wh-card h3 { font-size: 12px; margin: 0 0 8px; color: var(--text-secondary); font-weight: 500; }
.wh-secret-row { display: flex; align-items: center; gap: 8px; }
.wh-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.wh-code { background: var(--surface-subtle); border: 1px solid var(--border-subtle); border-radius: 6px;
  padding: 8px; white-space: pre-wrap; font-family: var(--font-mono); font-size: 11px; color: var(--text); }
`;

export function installStyle(el: HTMLElement): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  el.append(style);
}
