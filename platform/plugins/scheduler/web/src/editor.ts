/**
 * 定时任务编辑页（R1，`nav:false`）：新建 / 编辑同一个组件。
 *
 * 旧版 694 行是因为要按 source 渲染三套表单 + webhook secret 弹窗与轮换。
 * 现在只有两种计划（一次性 / 重复），合并成一个「计划」区就够。
 */

import type { PluginWebHost } from '@pi-agent-platform/plugin-types/web';
import {
  createClient,
  errMessage,
  fmtTime,
  h,
  renderState,
  STATUS_LABEL,
  type MetaDTO,
  type RunDTO,
  type TaskDTO,
} from './shared.js';

const STYLE_ID = 'sched-editor-style';
const CSS = `
.sched-form { display: flex; flex-direction: column; gap: 14px; font-size: 13px; max-width: 720px; }
.sched-form h2 { font-size: 15px; font-weight: 600; margin: 0; }
.sched-field { display: flex; flex-direction: column; gap: 4px; }
.sched-field > label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-secondary); }
.sched-field input, .sched-field select, .sched-field textarea {
  border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font: inherit;
  background: var(--surface); color: var(--text); }
.sched-field textarea { min-height: 90px; resize: vertical; }
.sched-row { display: flex; gap: 10px; flex-wrap: wrap; }
.sched-row > .sched-field { flex: 1; min-width: 180px; }
.sched-hint { font-size: 11px; color: var(--text-secondary); }
.sched-hint-err { color: var(--danger); }
.sched-actions { display: flex; gap: 8px; align-items: center; }
.sched-btn { border: 1px solid var(--border); background: var(--surface); color: var(--text);
  border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer; }
.sched-btn-primary { background: var(--accent); border-color: transparent; color: #fff; }
.sched-runs { margin-top: 18px; }
.sched-runs table { width: 100%; border-collapse: collapse; font-size: 12px; }
.sched-runs th { text-align: left; font-weight: 500; font-size: 11px; color: var(--text-secondary); padding: 4px 6px; }
.sched-runs td { padding: 6px; border-top: 1px solid var(--border-subtle); }
.sched-st-delivered { color: var(--success); }
.sched-st-skipped { color: var(--text-tertiary); }
.sched-st-missed { color: var(--warning); }
.sched-st-failed { color: var(--danger); }
.sched-state { padding: 24px; text-align: center; color: var(--text-secondary); }
.sched-state-error { color: var(--danger); }
`;

export function mount(el: HTMLElement, host: PluginWebHost): () => void {
  installStyle();
  const api = createClient(host);
  const root = h('div', { class: 'sched-form' });
  el.append(root);

  // 路由里的 id：页面注册为 `/scheduler/:id`，平台把 path 交给组件，
  // 插件从 location 里取最后一段（`new` = 新建）。
  const pathId = location.pathname.split('/').filter(Boolean).pop() ?? 'new';
  const taskId = pathId === 'new' ? null : pathId;

  let disposed = false;
  let meta: MetaDTO | null = null;
  let task: TaskDTO | null = null;
  let runs: RunDTO[] = [];

  void boot();

  async function boot(): Promise<void> {
    renderState(root, '加载中…');
    try {
      meta = await api.meta();
      if (taskId) {
        const res = await api.get(taskId);
        task = res.task;
        runs = res.runs;
      }
      if (!disposed) render();
    } catch (err) {
      if (!disposed) renderState(root, `加载失败：${errMessage(err)}`, 'error');
    }
  }

  function render(): void {
    if (!meta) return;
    const current = task;
    const scheduleKind = current?.scheduleKind ?? 'cron';
    const sessionMode = current?.sessionMode ?? 'new';

    // ── 表单字段 ──
    const nameInput = input('text', current?.name ?? '', '每天看盘');
    const promptInput = textarea(current?.prompt ?? '', '到点要执行的指令，写清楚输出什么、什么算成功');
    const agentSelect = select(
      meta.agents.map((a) => ({ value: a.id, label: a.name })),
      current?.agentId ?? meta.agents[0]?.id ?? '',
    );
    agentSelect.disabled = Boolean(current);

    const kinds = current?.scheduleKind ?? 'cron';
    const kindRadio = h('div', { class: 'sched-row' }) as HTMLElement;
    const cronInput = input('text', current?.cronExpr ?? '0 9 * * *', '0 9 * * *');
    const tzInput = input('text', current?.timezone ?? meta.defaultTimezone, meta.defaultTimezone);
    const onceInput = input('datetime-local', current?.at ? toLocalInput(current.at) : '', '');
    const sessionModeSelect = select(
      [
        { value: 'new', label: 'new — 每次触发新建会话' },
        { value: 'reuse', label: 'reuse — 固定复用一个会话' },
      ],
      sessionMode,
    );
    const sessionSelect = select([], current?.sessionId ?? '');
    const maxRunsInput = input('number', current?.maxRuns ? String(current.maxRuns) : '', '不限');
    maxRunsInput.type = 'number';

    const previewBox = h('div', { class: 'sched-hint', text: '下次运行：—' });

    const scheduleBox = h('div', { class: 'sched-field' });
    const rebuildScheduleBox = (): void => {
      const kind = (kindRadio.querySelector('input:checked') as HTMLInputElement | null)?.value ?? 'cron';
      scheduleBox.replaceChildren(
        h('label', { text: '计划' }),
        ...(kind === 'cron'
          ? [
              h('div', { class: 'sched-row' }, fieldWrap('cron 表达式（分 时 日 月 周）', cronInput, `最小间隔 ${meta?.minIntervalMinutes} 分钟`),
                fieldWrap('时区（IANA）', tzInput, meta?.defaultTimezone ?? '')),
            ]
          : [h('div', { class: 'sched-row' }, fieldWrap('执行时刻', onceInput, '一次性任务跑完自动停用'))]),
        previewBox,
      );
      void refreshPreview();
    };

    // 计划类型单选
    for (const [value, label] of [
      ['cron', '重复（cron）'],
      ['once', '一次性'],
    ] as Array<[string, string]>) {
      const radio = h('input', { type: 'radio', name: 'sched-kind', value }) as HTMLInputElement;
      radio.checked = kinds === value;
      radio.addEventListener('change', rebuildScheduleBox);
      kindRadio.append(h('label', { style: 'display:flex;align-items:center;gap:4px' }, radio, label));
    }

    async function refreshPreview(): Promise<void> {
      const kind = (kindRadio.querySelector('input:checked') as HTMLInputElement | null)?.value ?? 'cron';
      const body =
        kind === 'cron'
          ? { scheduleKind: 'cron', cronExpr: cronInput.value, timezone: tzInput.value }
          : { scheduleKind: 'once', at: onceInput.value ? new Date(onceInput.value).getTime() : undefined };
      try {
        const res = await api.preview(body);
        previewBox.textContent = res.ok ? `下次运行：${fmtTime(res.nextAt ?? null)}` : '';
        previewBox.classList.remove('sched-hint-err');
      } catch (err) {
        previewBox.textContent = errMessage(err);
        previewBox.classList.add('sched-hint-err');
      }
    }
    cronInput.addEventListener('blur', () => void refreshPreview());
    tzInput.addEventListener('blur', () => void refreshPreview());
    onceInput.addEventListener('change', () => void refreshPreview());

    // reuse 时拉该 agent 的会话列表
    async function refreshSessions(): Promise<void> {
      const mode = sessionModeSelect.value;
      const row = sessionSelect.closest('.sched-field') as HTMLElement | null;
      if (row) row.style.display = mode === 'reuse' ? '' : 'none';
      if (mode !== 'reuse') return;
      try {
        const res = await api.sessions(agentSelect.value);
        const opts = [{ value: '', label: '留空 = 首次触发时自动创建' }].concat(
          res.items.map((s) => ({ value: s.id, label: `${s.id.slice(0, 8)} · ${s.status}` })),
        );
        const keep = sessionSelect.value;
        sessionSelect.replaceChildren(...opts.map((o) => h('option', { value: o.value, text: o.label })));
        sessionSelect.value = keep;
      } catch {
        /* 列表失败不阻塞表单 */
      }
    }
    sessionModeSelect.addEventListener('change', () => void refreshSessions());

    async function save(): Promise<void> {
      const kind = (kindRadio.querySelector('input:checked') as HTMLInputElement | null)?.value ?? 'cron';
      const body: Record<string, unknown> = {
        name: nameInput.value.trim(),
        prompt: promptInput.value.trim(),
        sessionMode: sessionModeSelect.value,
      };
      if (!task) body.agentId = agentSelect.value;
      if (kind === 'cron') {
        body.scheduleKind = 'cron';
        body.cronExpr = cronInput.value.trim();
        body.timezone = tzInput.value.trim();
      } else {
        body.scheduleKind = 'once';
        body.at = onceInput.value ? new Date(onceInput.value).getTime() : undefined;
      }
      if (sessionModeSelect.value === 'reuse' && sessionSelect.value) body.sessionId = sessionSelect.value;
      if (task) {
        body.reschedule = true;
        body.maxRuns = maxRunsInput.value ? Number(maxRunsInput.value) : null;
      } else if (maxRunsInput.value) {
        body.maxRuns = Number(maxRunsInput.value);
      }
      try {
        if (task) await api.update(task.id, body);
        else await api.create(body);
        host.ui.toast('已保存', 'success');
        host.ui.navigate('/scheduler');
      } catch (err) {
        host.ui.toast(errMessage(err), 'error');
      }
    }

    async function toggleEnabled(): Promise<void> {
      if (!task) return;
      try {
        await api.update(task.id, { enabled: !task.enabled });
        const res = await api.get(task.id);
        task = res.task;
        runs = res.runs;
        render();
      } catch (err) {
        host.ui.toast(errMessage(err), 'error');
      }
    }

    const parts: Array<Node> = [
      h('h2', { text: task ? `编辑定时任务 · ${task.name}` : '新建定时任务' }),
      fieldWrap('名称', nameInput),
      fieldWrap('agent', agentSelect, task ? '创建后不可改 agent' : ''),
      h('div', { class: 'sched-field' }, h('label', { text: '计划类型' }), kindRadio),
      scheduleBox,
      fieldWrap('指令（到点进入会话的 prompt）', promptInput),
      h('div', { class: 'sched-row' }, fieldWrap('会话模式', sessionModeSelect), fieldWrap('最大运行次数（留空=不限）', maxRunsInput)),
      fieldWrap('目标会话（reuse）', sessionSelect),
      h(
        'div',
        { class: 'sched-actions' },
        h('button', { class: 'sched-btn sched-btn-primary', text: '保存', onClick: () => void save() }),
        h('button', { class: 'sched-btn', text: '返回列表', onClick: () => host.ui.navigate('/scheduler') }),
      ),
    ];
    if (task) {
      (parts[parts.length - 1] as HTMLElement).append(
        h('button', {
          class: 'sched-btn',
          text: task.enabled ? '停用' : '启用',
          onClick: () => {
            void toggleEnabled();
          },
        }),
      );
      parts.push(renderRuns(runs));
    }
    root.replaceChildren(...parts);

    rebuildScheduleBox();
    void refreshSessions();
  }

  return () => {
    disposed = true;
    root.remove();
    document.getElementById(STYLE_ID)?.remove();
  };
}

function renderRuns(runs: RunDTO[]): HTMLElement {
  const box = h('div', { class: 'sched-runs' }, h('label', { text: `最近运行（${runs.length}）`, style: 'font-size:11px;text-transform:uppercase;color:var(--text-secondary)' }));
  if (runs.length === 0) {
    box.append(h('div', { class: 'sched-hint', text: '还没有运行记录。' }));
    return box;
  }
  const tbody = h('tbody');
  for (const run of runs) {
    tbody.append(
      h(
        'tr',
        {},
        h('td', { class: `sched-st-${run.status}`, text: STATUS_LABEL[run.status] ?? run.status }),
        h('td', { text: fmtTime(run.startedAt) }),
        h('td', { text: run.triggeredBy }),
        h('td', { text: run.sessionId ? run.sessionId.slice(0, 8) : '—' }),
        h('td', { class: 'sched-hint', text: run.reason ?? '' }),
      ),
    );
  }
  box.append(
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ...['状态', '开始', '触发方', '会话', '原因'].map((t) => h('th', { text: t })))),
      tbody,
    ),
  );
  return box;
}

function fieldWrap(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h(
    'div',
    { class: 'sched-field' },
    h('label', { text: label }),
    control,
    hint ? h('div', { class: 'sched-hint', text: hint }) : null,
  );
}

function input(type: string, value: string, placeholder: string): HTMLInputElement {
  const el = document.createElement('input');
  el.type = type;
  el.value = value;
  el.placeholder = placeholder;
  return el;
}

function textarea(value: string, placeholder: string): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.value = value;
  el.placeholder = placeholder;
  return el;
}

function select(options: Array<{ value: string; label: string }>, value: string): HTMLSelectElement {
  const el = document.createElement('select');
  el.replaceChildren(...options.map((o) => h('option', { value: o.value, text: o.label })));
  el.value = value;
  return el;
}

function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function installStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}
