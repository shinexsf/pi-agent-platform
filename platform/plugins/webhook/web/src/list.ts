/**
 * webhook 列表页（R1，导航「Webhook」）。
 *
 * 一屏看完：名称 / agent / 会话模式 / 最近投递 / 状态 + 行内 ⧉（复制 URL）✎ 🗑。
 * 投递记录在详情页 —— 外部事件的过程数据不该抢列表的注意力。
 */

import type { PluginWebHost } from '@pi-agent-platform/plugin-types/web';
import {
  copyText,
  createClient,
  errMessage,
  fmtTime,
  h,
  installStyle,
  originOf,
  renderState,
  type HookDTO,
  type MetaDTO,
} from './shared.js';

export function mount(el: HTMLElement, host: PluginWebHost): () => void {
  installStyle(el);
  const api = createClient(host);
  const root = h('div', { class: 'wh-root' });
  el.append(root);

  let meta: MetaDTO | null = null;
  let showDisabled = false;
  let disposed = false;

  const agentName = (id: string): string => meta?.agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);
  const fullUrl = (id: string): string => `${originOf()}/api/p/webhook/hooks/${id}`;

  async function load(): Promise<void> {
    renderState(root, '加载中…');
    try {
      if (!meta) meta = await api.meta();
      const res = await api.list(showDisabled);
      if (disposed) return;
      render(res.items);
    } catch (err) {
      if (!disposed) renderState(root, `加载失败：${errMessage(err)}`, 'error');
    }
  }

  function render(items: HookDTO[]): void {
    const bar = h(
      'div',
      { class: 'wh-bar' },
      h('h2', { text: 'Webhook' }),
      h('span', { class: 'wh-sub', text: `${items.length} 个入口` }),
      h('span', { class: 'wh-spacer' }),
      h('label', { class: 'wh-sub' }, checkbox(showDisabled, (v) => {
        showDisabled = v;
        void load();
      }), '显示已停用'),
      h('button', { class: 'wh-btn wh-btn-primary', text: '新建', onClick: () => host.ui.navigate('/webhooks/new') }),
    );

    if (items.length === 0) {
      root.replaceChildren(
        bar,
        h('div', { class: 'wh-empty', text: '还没有 webhook。新建一个，把 URL + secret 交给要调用你的外部系统。' }),
      );
      return;
    }

    const rows = items.map((hook) =>
      h(
        'tr',
        {},
        h(
          'td',
          {},
          h('div', { class: 'wh-name', text: hook.name }),
          h('div', { class: 'wh-sub wh-mono', text: hook.id }),
        ),
        h('td', { text: agentName(hook.agentId) }),
        h('td', {}, h('div', { text: hook.sessionMode }), h('div', { class: 'wh-sub', text: hook.sessionId?.slice(0, 8) ?? '未绑定' })),
        h(
          'td',
          {},
          h('div', { text: `${hook.deliveriesCount} 次` }),
          h('div', { class: 'wh-sub', text: hook.lastDeliveredAt ? fmtTime(hook.lastDeliveredAt) : '从未' }),
        ),
        h(
          'td',
          {},
          h('span', {
            class: `wh-pill ${hook.enabled ? 'wh-pill-on' : 'wh-pill-off'}`,
            text: hook.enabled ? '启用' : '停用',
          }),
        ),
        h(
          'td',
          {},
          h(
            'div',
            { class: 'wh-actions' },
            h('button', {
              class: 'wh-btn wh-btn-icon',
              title: '复制 URL',
              text: '⧉',
              onClick: () => void copy(fullUrl(hook.id), 'URL 已复制'),
            }),
            h('button', {
              class: 'wh-btn wh-btn-icon',
              title: '编辑',
              text: '✎',
              onClick: () => host.ui.navigate(`/webhooks/${hook.id}`),
            }),
            h('button', {
              class: 'wh-btn wh-btn-icon',
              title: '删除',
              text: '🗑',
              onClick: () => void remove(hook),
            }),
          ),
        ),
      ),
    );

    root.replaceChildren(
      bar,
      h(
        'table',
        { class: 'wh-table' },
        h('thead', {}, h('tr', {}, ...['名称', 'agent', '会话', '投递', '状态', ''].map((t) => h('th', { text: t })))),
        h('tbody', {}, ...rows),
      ),
    );
  }

  async function copy(value: string, okMessage: string): Promise<void> {
    const ok = await copyText(value);
    host.ui.toast(ok ? okMessage : '复制失败，请手动选中', ok ? 'success' : 'error');
  }

  async function remove(hook: HookDTO): Promise<void> {
    if (!window.confirm(`删除「${hook.name}」？投递记录一并删除，外部系统再调这个 URL 会 404。`)) return;
    try {
      await api.remove(hook.id);
      host.ui.toast('已删除', 'success');
      void load();
    } catch (err) {
      host.ui.toast(errMessage(err), 'error');
    }
  }

  function checkbox(checked: boolean, onChange: (v: boolean) => void): HTMLInputElement {
    const box = h('input', { type: 'checkbox' }) as HTMLInputElement;
    box.checked = checked;
    box.style.marginRight = '4px';
    box.addEventListener('change', () => onChange(box.checked));
    return box;
  }

  void load();
  return () => {
    disposed = true;
  };
}
