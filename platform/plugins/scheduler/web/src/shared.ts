/**
 * 定时任务 UI 的共享小工具（list / editor 共用）。
 *
 * 为什么是原生 DOM：web facet 的契约就是 `mount(el, host)` —— 平台只给一个挂载点和
 * 一组能力（api / navigate / toast / sheet / theme），不给组件库。插件自带的 UI 越接近
 * "就是个 DOM 片段"，跨框架、跨版本的稳定性越好。
 */

import type { PluginWebHost } from '@pi-agent-platform/plugin-types/web';

export interface TaskDTO {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  scheduleKind: 'cron' | 'once';
  cronExpr: string | null;
  timezone: string | null;
  at: number | null;
  sessionMode: 'new' | 'reuse';
  sessionId: string | null;
  busyPolicy: 'followUp' | 'steer' | 'skip';
  enabled: boolean;
  nextAt: number | null;
  maxRuns: number | null;
  runsCount: number;
  lastFiredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunDTO {
  id: string;
  status: 'delivered' | 'skipped' | 'missed' | 'failed';
  reason: string | null;
  triggeredBy: string;
  sessionId: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface MetaDTO {
  agents: Array<{ id: string; name: string }>;
  defaultTimezone: string;
  minIntervalMinutes: number;
  now: number;
}

/**
 * 极简建 DOM 助手。
 *
 * `attrs` 里 `on*` 的值当事件处理器（`onClick` → `click`），其余当 HTML 属性；
 * `children` 里的 `null` / `false` 直接跳过，方便写条件渲染而不用先拼数组。
 */
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

export const fmtRelative = (ms: number | null): string => {
  if (!ms) return '—';
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const unit: Array<[number, string]> = [
    [60_000, '秒'],
    [3_600_000, '分钟'],
    [86_400_000, '小时'],
    [Infinity, '天'],
  ];
  const base = abs < 60_000 ? 1_000 : abs < 3_600_000 ? 60_000 : abs < 86_400_000 ? 3_600_000 : 86_400_000;
  const divisor = base === 1_000 ? 1_000 : base;
  void unit;
  const value = Math.round(abs / divisor);
  const label = { 1000: '秒', 60000: '分钟', 3600000: '小时', 86400000: '天' }[divisor] ?? '';
  return diff >= 0 ? `${value} ${label}后` : `${value} ${label}前`;
};

/** 计划的人读形态。 */
export function describeSchedule(task: TaskDTO): string {
  if (task.scheduleKind === 'once') return `一次性 · ${fmtTime(task.at)}`;
  return `${task.cronExpr} (${task.timezone})`;
}

export const STATUS_LABEL: Record<RunDTO['status'], string> = {
  delivered: '已送达',
  skipped: '已跳过',
  missed: '已错过',
  failed: '失败',
};

/** 加载态 / 错误态的统一渲染。 */
export function renderState(el: HTMLElement, text: string, kind: 'loading' | 'error' | 'empty' = 'loading'): void {
  el.replaceChildren(
    h('div', { class: `sched-state sched-state-${kind}`, text }),
  );
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
      host.api.get(`tasks${includeDisabled ? '?includeDisabled=1' : ''}`) as Promise<{ items: TaskDTO[] }>,
    get: (id: string) => host.api.get(`tasks/${id}`) as Promise<{ task: TaskDTO; runs: RunDTO[] }>,
    create: (body: Record<string, unknown>) => host.api.post('tasks', body) as Promise<TaskDTO>,
    update: (id: string, body: Record<string, unknown>) => host.api.put(`tasks/${id}`, body) as Promise<TaskDTO>,
    remove: (id: string) => host.api.del(`tasks/${id}`) as Promise<unknown>,
    run: (id: string) => host.api.post(`tasks/${id}/run`, {}) as Promise<{ status: string; reason?: string }>,
    preview: (body: Record<string, unknown>) =>
      host.api.post('preview', body) as Promise<{ ok: boolean; nextAt?: number | null; error?: string }>,
  };
}

export const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
