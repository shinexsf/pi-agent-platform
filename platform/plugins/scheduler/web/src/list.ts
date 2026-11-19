/**
 * 定时任务列表页（R1，导航「定时任务」）。
 *
 * 一屏看完：名称 / agent / 计划 / 下次 / 上次 / runs / 状态 + 行内 ▶ ✎ 🗑。
 * 不做行内展开（runs 在详情页），与旧版列表页同一条取舍。
 */

import type { PluginWebHost } from '@pi-agent-platform/plugin-types/web';
import {
  createClient,
  describeSchedule,
  errMessage,
  fmtRelative,
  fmtTime,
  h,
  renderState,
  type MetaDTO,
  type TaskDTO,
} from './shared.js';

const STYLE_ID = 'sched-list-style';
const CSS = `
.sched-root { display: flex; flex-direction: column; gap: 12px; font-size: 13px; }
.sched-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sched-bar h2 { font-size: 15px; font-weight: 600; margin: 0; }
.sched-spacer { flex: 1; }
.sched-btn { border: 1px solid var(--border); background: var(--surface); color: var(--text);
  border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.sched-btn:hover { background: var(--surface-hover); }
.sched-btn-primary { background: var(--accent); border-color: transparent; color: #fff; }
.sched-btn-icon { padding: 2px 6px; }
.sched-table { width: 100%; border-collapse: collapse; }
.sched-table th { text-align: left; font-weight: 500; font-size: 11px; text-transform: uppercase;
  letter-spacing: .04em; color: var(--text-secondary); padding: 6px 8px; border-bottom: 1px solid var(--border); }
.sched-table td { padding: 8px; border-bottom: 1px solid var(--border-subtle); vertical-align: top; }
.sched-name { font-weight: 500; }
.sched-sub { color: var(--text-secondary); font-size: 11px; }
.sched-pill { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 11px; }
.sched-pill-on { background: var(--success-soft); color: var(--success); }
.sched-pill-off { background: var(--surface-subtle); color: var(--text-secondary); }
.sched-pill-fail { background: var(--danger-soft); color: var(--danger); }
.sched-state { padding: 24px; text-align: center; color: var(--text-secondary); }
.sched-state-error { color: var(--danger); }
.sched-empty { padding: 40px; text-align: center; color: var(--text-secondary); }
`;

export function mount(el: HTMLElement, host: PluginWebHost): () => void {
  installStyle(el);
  const api = createClient(host);
  const root = h('div', { class: 'sched-root' });
  el.append(root);

  let meta: MetaDTO | null = null;
  let showDisabled = false;
  let disposed = false;

  const agentName = (id: string): string => meta?.agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);

  async function load(): Promise<void> {
    renderState(root, '加载中…');
    try {
      if (!meta) meta = await api.meta();
      const { items } = await api.list(showDisabled);
      if (disposed) return;
      render(items);
    } catch (err) {
      if (!disposed) renderState(root, `加载失败：${errMessage(err)}`, 'error');
    }
  }

  function render(tasks: TaskDTO[]): void {
    const bar = h(
      'div',
      { class: 'sched-bar' },
      h('h2', { text: `定时任务（${tasks.length}）` }),
      h('div', { class: 'sched-spacer' }),
      checkbox('显示已停用', showDisabled, (v) => {
        showDisabled = v;
        void load();
      }),
      h('button', { class: 'sched-btn', text: '刷新', onClick: () => void load() }),
      h('button', {
        class: 'sched-btn sched-btn-primary',
        text: '新建定时任务',
        onClick: () => host.ui.navigate('/scheduler/new'),
      }),
    );

    if (tasks.length === 0) {
      root.replaceChildren(bar, h('div', { class: 'sched-empty', text: '还没有定时任务。点右上角「新建定时任务」。' }));
      return;
    }

    const tbody = h('tbody');
    for (const task of tasks) {
      tbody.append(
        h(
          'tr',
          {},
          h(
            'td',
            {},
            h('div', { class: 'sched-name', text: task.name }),
            h('div', { class: 'sched-sub', text: task.prompt.slice(0, 60) }),
          ),
          h('td', { class: 'sched-sub', text: agentName(task.agentId) }),
          h('td', { class: 'sched-sub', text: describeSchedule(task) }),
          h(
            'td',
            {},
            h('div', { text: fmtTime(task.nextAt) }),
            h('div', { class: 'sched-sub', text: task.enabled ? fmtRelative(task.nextAt) : '已停用' }),
          ),
          h('td', { class: 'sched-sub', text: fmtTime(task.lastFiredAt) }),
          h('td', {
            class: 'sched-sub',
            text: task.maxRuns ? `${task.runsCount}/${task.maxRuns}` : String(task.runsCount),
          }),
          h(
            'td',
            {},
            h('span', {
              class: `sched-pill ${task.enabled ? 'sched-pill-on' : 'sched-pill-off'}`,
              text: task.enabled ? '启用' : '停用',
            }),
          ),
          h(
            'td',
            {},
            h(
              'div',
              { style: 'display:flex;gap:4px' },
              h('button', {
                class: 'sched-btn sched-btn-icon',
                title: '立即运行',
                text: '▶',
                onClick: async () => {
                  try {
                    const r = await api.run(task.id);
                    host.ui.toast(
                      r.status === 'delivered' ? '已送达会话' : `未送达：${r.reason ?? r.status}`,
                      r.status === 'delivered' ? 'success' : 'error',
                    );
                    void load();
                  } catch (err) {
                    host.ui.toast(errMessage(err), 'error');
                  }
                },
              }),
              h('button', {
                class: 'sched-btn sched-btn-icon',
                title: '编辑',
                text: '✎',
                onClick: () => host.ui.navigate(`/scheduler/${task.id}`),
              }),
              h('button', {
                class: 'sched-btn sched-btn-icon',
                title: '删除',
                text: '🗑',
                onClick: async () => {
                  if (!window.confirm(`删除定时任务「${task.name}」？历史运行记录也会删除。`)) return;
                  try {
                    await api.remove(task.id);
                    host.ui.toast('已删除', 'success');
                    void load();
                  } catch (err) {
                    host.ui.toast(errMessage(err), 'error');
                  }
                },
              }),
            ),
          ),
        ),
      );
    }

    root.replaceChildren(
      bar,
      h(
        'table',
        { class: 'sched-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            ...['名称', 'agent', '计划', '下次', '上次', 'runs', '状态', ''].map((label) =>
              h('th', { text: label }),
            ),
          ),
        ),
        tbody,
      ),
    );
  }

  void load();
  return () => {
    disposed = true;
    root.remove();
    document.getElementById(STYLE_ID)?.remove();
  };
}

function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const wrap = h('label', { style: 'display:flex;align-items:center;gap:4px;font-size:12px' }, input, label);
  return wrap;
}

/** 样式只注入一次；卸载时移除（插件不得写全局 CSS 选择器，全部挂在 .sched-* 下）。 */
function installStyle(_el: HTMLElement): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}
