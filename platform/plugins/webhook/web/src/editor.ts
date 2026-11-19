/**
 * webhook 详情 / 编辑页（R1，`/webhooks/new`、`/webhooks/:id`，`nav: false`）。
 *
 * 这块 UI 有两个"必须一眼看到"的东西：**URL** 和 **secret**。
 * 它们不是配置项，而是"要交给外部系统的东西" —— 藏在折叠面板里就等于每天都在找。
 */

import type { PluginWebHost } from '@pi-agent-platform/plugin-types/web';
import {
  BUSY_LABEL,
  copyText,
  createClient,
  errMessage,
  fmtBytes,
  fmtTime,
  h,
  installStyle,
  originOf,
  renderState,
  STATUS_LABEL,
  type DeliveryDTO,
  type HookDTO,
  type MetaDTO,
} from './shared.js';

export function mount(el: HTMLElement, host: PluginWebHost): () => void {
  installStyle(el);
  const api = createClient(host);
  const root = h('div', { class: 'wh-root' });
  el.append(root);

  // 路由里的 id：页面注册为 `/webhooks/:id`，平台**不给** mount 传路由参数，
  // 插件从地址栏取最后一段（`new` = 新建）—— 与 scheduler 同一约定。
  const pathId = location.pathname.split('/').filter(Boolean).pop() ?? 'new';
  const hookId = pathId === 'new' ? null : pathId;
  let meta: MetaDTO | null = null;
  let hook: HookDTO | null = null;
  let deliveries: DeliveryDTO[] = [];
  let disposed = false;

  async function load(): Promise<void> {
    renderState(root, '加载中…');
    try {
      if (!meta) meta = await api.meta();
      if (hookId) {
        const res = await api.get(hookId);
        hook = res.hook;
        deliveries = res.deliveries;
      }
      if (!disposed) render();
    } catch (err) {
      if (!disposed) renderState(root, `加载失败：${errMessage(err)}`, 'error');
    }
  }

  function render(): void {
    if (!meta) return;
    const current = hook;
    const sessionMode = current?.sessionMode ?? 'new';

    // ── 表单字段 ──
    const nameInput = input('text', current?.name ?? '', 'CI 失败');
    const promptInput = textarea(
      current?.prompt ?? '',
      '事件到达时要执行的指令，写清楚看什么、输出什么、什么算成功',
    );
    const agentSelect = select(
      meta.agents.map((a) => ({ value: a.id, label: a.name })),
      current?.agentId ?? meta.agents[0]?.id ?? '',
    );
    agentSelect.disabled = Boolean(current);
    const sessionModeSelect = select(
      [
        { value: 'new', label: 'new — 每个事件新建会话' },
        { value: 'reuse', label: 'reuse — 固定复用一个会话' },
      ],
      sessionMode,
    );
    const sessionSelect = select([], current?.sessionId ?? '');
    const busySelect = select(
      [
        { value: 'followUp', label: 'followUp — 排队，等当前轮结束再送（默认）' },
        { value: 'steer', label: 'steer — 插队到当前轮之后的下一次模型调用' },
        { value: 'skip', label: 'skip — 这次不投，记一条 skipped' },
      ],
      current?.busyPolicy ?? 'followUp',
    );

    async function refreshSessions(): Promise<void> {
      const mode = sessionModeSelect.value;
      const row = sessionSelect.closest('.wh-field') as HTMLElement | null;
      if (row) row.style.display = mode === 'reuse' ? '' : 'none';
      if (mode !== 'reuse') return;
      try {
        const res = await api.sessions(agentSelect.value);
        const opts = [{ value: '', label: '留空 = 首次投递时自动创建' }].concat(
          res.items.map((s) => ({ value: s.id, label: `${s.id.slice(0, 8)} · ${s.status}` })),
        );
        // 绑定的会话可能已不在列表里（被删/换了 agent）—— 仍要显示出来，
        // 否则用户看到的是"留空"，会以为绑定丢了。
        const bound = current?.sessionId;
        if (bound && !opts.some((o) => o.value === bound)) {
          opts.push({ value: bound, label: `${bound.slice(0, 8)} · 已失效` });
        }
        const keep = sessionSelect.value;
        sessionSelect.replaceChildren(...opts.map((o) => h('option', { value: o.value, text: o.label })));
        sessionSelect.value = keep;
      } catch {
        /* 列表失败不阻塞表单 */
      }
    }
    sessionModeSelect.addEventListener('change', () => void refreshSessions());

    async function save(): Promise<void> {
      const body: Record<string, unknown> = {
        name: nameInput.value.trim(),
        prompt: promptInput.value.trim(),
        sessionMode: sessionModeSelect.value,
        busyPolicy: busySelect.value,
      };
      if (!current) body.agentId = agentSelect.value;
      if (sessionModeSelect.value === 'reuse' && sessionSelect.value) body.sessionId = sessionSelect.value;
      if (current && sessionModeSelect.value === 'reuse' && !sessionSelect.value) body.sessionId = '';
      try {
        if (current) {
          await api.update(current.id, body);
          host.ui.toast('已保存', 'success');
          await load();
        } else {
          const res = await api.create(body);
          host.ui.toast('已创建', 'success');
          host.ui.navigate(`/webhooks/${res.hook.id}`);
        }
      } catch (err) {
        host.ui.toast(errMessage(err), 'error');
      }
    }

    async function toggleEnabled(): Promise<void> {
      if (!current) return;
      try {
        await api.update(current.id, { enabled: !current.enabled });
        await load();
      } catch (err) {
        host.ui.toast(errMessage(err), 'error');
      }
    }

    async function rotate(): Promise<void> {
      if (!current) return;
      if (!window.confirm('重置 secret？外部系统用旧 secret 会立刻失效（401）。')) return;
      try {
        const res = await api.rotate(current.id);
        host.ui.toast('secret 已重置，记得更新调用方', 'success');
        await load();
        void res;
      } catch (err) {
        host.ui.toast(errMessage(err), 'error');
      }
    }

    async function testRun(): Promise<void> {
      if (!current) return;
      try {
        const res = await api.run(current.id, { event: 'manual.test', source: 'web-ui' });
        host.ui.toast(
          res.status === 'delivered' ? '已投递' : `未投递：${res.reason ?? res.status}`,
          res.status === 'delivered' ? 'success' : 'error',
        );
        await load();
      } catch (err) {
        host.ui.toast(errMessage(err), 'error');
      }
    }

    const parts: Array<Node> = [
      h(
        'div',
        { class: 'wh-bar' },
        h('h2', { text: current ? `编辑 Webhook · ${current.name}` : '新建 Webhook' }),
        h('span', { class: 'wh-spacer' }),
        h('button', { class: 'wh-btn', text: '返回列表', onClick: () => host.ui.navigate('/webhooks') }),
      ),
    ];

    if (current) parts.push(credentialsCard(current, host, rotate));

    parts.push(
      fieldWrap('名称', nameInput),
      fieldWrap('agent', agentSelect, current ? '创建后不可改 agent' : ''),
      fieldWrap('指令（事件到达时进入会话的 prompt）', promptInput),
      h(
        'div',
        { class: 'wh-row' },
        fieldWrap('会话模式', sessionModeSelect),
        fieldWrap('收到事件时 agent 正忙怎么办', busySelect, '默认排队（不丢事件）；高频事件建议 skip'),
      ),
      fieldWrap('目标会话（reuse）', sessionSelect),
      h(
        'div',
        { class: 'wh-actions' },
        h('button', { class: 'wh-btn wh-btn-primary', text: '保存', onClick: () => void save() }),
        current
          ? h('button', { class: 'wh-btn', text: current.enabled ? '停用' : '启用', onClick: () => void toggleEnabled() })
          : null,
        current ? h('button', { class: 'wh-btn', text: '试投', onClick: () => void testRun() }) : null,
      ),
    );

    if (current) parts.push(deliveriesCard(deliveries));

    root.replaceChildren(...parts);
    void refreshSessions();
  }

  void load();
  return () => {
    disposed = true;
  };

  // ── 子块 ──

  function credentialsCard(current: HookDTO, host2: PluginWebHost, onRotate: () => Promise<void>): HTMLElement {
    const url = `${originOf()}/api/p/webhook/hooks/${current.id}`;
    const curl = [
      `curl -X POST '${url}' \\`,
      `  -H 'Authorization: Bearer ${current.secret}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '{"event":"deploy.failed","service":"api"}'`,
    ].join('\n');
    return h(
      'div',
      { class: 'wh-card' },
      h('h3', { text: '交给外部系统的东西' }),
      h('div', { class: 'wh-field' }, h('label', { text: 'URL' }), h('div', { class: 'wh-mono', text: url })),
      h(
        'div',
        { class: 'wh-field' },
        h('label', { text: 'Secret（Authorization: Bearer …）' }),
        h(
          'div',
          { class: 'wh-secret-row' },
          h('div', { class: 'wh-mono', text: current.secret }),
        ),
      ),
      h(
        'div',
        { class: 'wh-actions' },
        h('button', {
          class: 'wh-btn',
          text: '复制 URL',
          onClick: () => void copyTo(host2, url, 'URL 已复制'),
        }),
        h('button', {
          class: 'wh-btn',
          text: '复制 secret',
          onClick: () => void copyTo(host2, current.secret, 'secret 已复制'),
        }),
        h('button', { class: 'wh-btn', text: '重置 secret', onClick: () => void onRotate() }),
      ),
      h('div', { class: 'wh-hint', text: `body 上限 ${fmtBytes(meta?.maxBodyBytes ?? null)}，超出截断。同一 Idempotency-Key 在 24h 内只执行一次。` }),
      h('div', { class: 'wh-code', text: curl }),
    );
  }

  function deliveriesCard(items: DeliveryDTO[]): HTMLElement {
    const rows = items.map((d) =>
      h(
        'tr',
        {},
        h(
          'td',
          {},
          h('span', {
            class: `wh-pill ${d.status === 'delivered' ? 'wh-pill-on' : d.status === 'failed' ? 'wh-pill-fail' : 'wh-pill-off'}`,
            text: STATUS_LABEL[d.status],
          }),
        ),
        h('td', { text: fmtTime(d.receivedAt) }),
        h('td', { text: d.triggeredBy }),
        h('td', { text: fmtBytes(d.payloadBytes) }),
        h('td', { class: 'wh-sub', text: d.sessionId?.slice(0, 8) ?? '—' }),
        h('td', { class: 'wh-sub', text: d.reason ?? (d.idempotencyKey ? `idem:${d.idempotencyKey}` : '—') }),
      ),
    );
    return h(
      'div',
      { class: 'wh-card' },
      h('h3', { text: '最近投递（最多 20 条）' }),
      items.length === 0
        ? h('div', { class: 'wh-sub', text: '还没有投递记录。' })
        : h(
            'table',
            { class: 'wh-table' },
            h(
              'thead',
              {},
              h('tr', {}, ...['状态', '收到时间', '触发方', 'body', '会话', '原因'].map((t) => h('th', { text: t }))),
            ),
            h('tbody', {}, ...rows),
          ),
    );
  }
}

// ── 小工具 ──

async function copyTo(host: PluginWebHost, value: string, message: string): Promise<void> {
  const ok = await copyText(value);
  host.ui.toast(ok ? message : '复制失败，请手动选中', ok ? 'success' : 'error');
}

function fieldWrap(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h(
    'div',
    { class: 'wh-field' },
    h('label', { text: label }),
    control,
    hint ? h('div', { class: 'wh-hint', text: hint }) : null,
  );
}

function input(type: string, value: string, placeholder: string): HTMLInputElement {
  return h('input', { type, value, placeholder }) as HTMLInputElement;
}

function textarea(value: string, placeholder: string): HTMLTextAreaElement {
  const el = h('textarea', { placeholder }) as HTMLTextAreaElement;
  el.value = value;
  return el;
}

function select(options: Array<{ value: string; label: string }>, value: string): HTMLSelectElement {
  const el = h('select', {}) as HTMLSelectElement;
  el.replaceChildren(...options.map((o) => h('option', { value: o.value, text: o.label })));
  el.value = value;
  return el;
}

void BUSY_LABEL;
