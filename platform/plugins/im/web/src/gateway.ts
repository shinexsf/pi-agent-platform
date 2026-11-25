/**
 * 网关页（`/im`，挂在「配置」下）—— 渠道分组卡片 / 整卡折叠 / 新增弹窗 / 编辑会话弹窗。
 *
 * 渲染归属（spec `im-gateway-admin`）：
 * - 渠道卡 header、连接卡、会话绑定、事件流 —— **网关自己渲染**
 * - 「新增连接」弹窗的**内容** —— 渠道插件通过槽位 `im.channel.create` 提供，
 *   这里只负责按注册项的 `url` 动态 `import()` 并 `mount()`（URL 由服务端给，不自己拼）
 *
 * 契约是 DOM（`mount(el, host)`）；主题只用平台公开的 CSS 变量。
 */

interface BindingRow {
  chatId: string;
  sessionId: string;
  updatedAt: number;
}

interface ConnectionRow {
  id: string;
  providerId: string;
  type: string;
  label: string;
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error' | 'unknown';
  lastError?: string;
  agentId?: string;
  defaultSessionId?: string;
  canRemove: boolean;
  bindings: BindingRow[];
}

interface ChannelRow {
  providerId: string;
  type: string;
  label: string;
  connections: number;
  canSendFile: boolean;
}

/** `GET /api/extensions` 的槽位注册项（插件空间槽位，宿主自己装载）。 */
interface SurfaceRow {
  pluginId: string;
  slot: string;
  id: string;
  title?: string;
  icon?: string;
  order?: number;
  component: string;
  url: string;
}

interface AgentRow {
  id: string;
  name?: string;
}

interface SessionRow {
  id: string;
  title?: string;
  agentId?: string;
}

/** 槽位组件的宿主上下文（渠道作者按这个形状实现 `mount`）。 */
interface CreateHost {
  done(): void;
  cancel(): void;
  fail(message: string): void;
}

interface WebHost {
  ui?: { navigate?(path: string): void };
}

const PREFIX = '/api/p/im';
const CREATE_SLOT = 'im.channel.create';

// ── 数据 ──────────────────────────────────────────────────────────────────

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return body as T;
}

const state = {
  connections: [] as ConnectionRow[],
  channels: [] as ChannelRow[],
  surfaces: [] as SurfaceRow[],
  agents: [] as AgentRow[],
  collapsed: new Set<string>(),
  sessionCache: new Map<string, SessionRow[]>(),
};

async function refresh(): Promise<void> {
  const [conn, ext] = await Promise.all([
    apiJson<{ channels: ChannelRow[]; connections: ConnectionRow[] }>(`${PREFIX}/connections`),
    apiJson<{ surfaces?: SurfaceRow[] }>('/api/extensions').catch(() => ({ surfaces: [] as SurfaceRow[] })),
  ]);
  state.channels = conn.channels ?? [];
  state.connections = conn.connections ?? [];
  state.surfaces = (ext.surfaces ?? []).filter((s) => s.slot === CREATE_SLOT);
  state.sessionCache.clear();
}

function creatorFor(providerId: string): SurfaceRow | undefined {
  return state.surfaces
    .filter((s) => s.pluginId === providerId)
    .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))[0];
}

async function loadAgents(): Promise<AgentRow[]> {
  const body = await apiJson<AgentRow[] | { agents?: AgentRow[] }>('/api/agents').catch(() => []);
  const list = Array.isArray(body) ? body : (body.agents ?? []);
  state.agents = list.map((a) => ({ id: a.id, name: a.name ?? a.id }));
  return state.agents;
}

async function loadSessions(agentId: string): Promise<SessionRow[]> {
  const cached = state.sessionCache.get(agentId);
  if (cached) return cached;
  // 注意参数名是 `agent_id`（snake_case）；写成 `agentId` 会被静默忽略、返回全部会话。
  const body = await apiJson<SessionRow[] | { sessions?: SessionRow[] }>(
    `/api/sessions?agent_id=${encodeURIComponent(agentId)}`,
  ).catch(() => []);
  const all = Array.isArray(body) ? body : (body.sessions ?? []);
  // 双保险：只保留该 agent 的会话（服务端过滤是唯一依据，这里只是防线）。
  const list = all.filter((s) => !s.agentId || s.agentId === agentId);
  state.sessionCache.set(agentId, list);
  return list;
}

// ── 极简 DOM 工具 ─────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', `imw-btn ${cls}`, label);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** 样式只注入一次（`?v=` 会让模块重载，用 id 去重）。 */
function ensureStyle(): void {
  if (document.getElementById('imw-style')) return;
  const style = el('style');
  style.id = 'imw-style';
  style.textContent = `
.imw { display: flex; flex-direction: column; gap: 14px; padding: 16px; color: var(--text); font-size: 14px; }
.imw-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.imw-head h2 { margin: 0; font-size: 18px; }
.imw-sub { color: var(--text-tertiary); font-size: 12.5px; }
.imw-spacer { margin-left: auto; }
.imw-btn {
  border: 1px solid var(--border); background: transparent; color: var(--text);
  border-radius: var(--radius-sm); padding: 4px 10px; cursor: pointer; font: inherit; font-size: 12px;
}
.imw-btn:hover:not([disabled]) { background: var(--surface-hover); }
.imw-btn[disabled] { opacity: .45; cursor: not-allowed; }
.imw-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 560; }
.imw-btn.primary:hover:not([disabled]) { background: var(--accent-hover); }
.imw-btn.danger { color: var(--danger); border-color: transparent; }
.imw-btn.danger:hover:not([disabled]) { background: var(--danger-soft); }
.imw-btn.ghost { border-color: transparent; color: var(--text-secondary); }
.imw-btn.ghost:hover:not([disabled]) { background: var(--surface-hover); }
.imw-provider { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-raised); box-shadow: var(--shadow-soft); overflow: hidden; }
.imw-phead { display: flex; align-items: center; gap: 10px; padding: 11px 14px; cursor: pointer; }
.imw-phead:hover { background: var(--surface-subtle); }
.imw-chev { width: 14px; color: var(--text-tertiary); font-size: 11px; transition: transform .16s ease; }
.imw-provider.open .imw-chev { transform: rotate(90deg); }
.imw-badge { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; font-weight: 700; font-size: 12.5px; color: #fff; background: linear-gradient(140deg, var(--accent), var(--accent-hover)); flex: none; }
.imw-pname { font-weight: 620; font-size: 14px; }
.imw-chip { font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary); border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px; background: var(--surface); }
.imw-count { color: var(--text-tertiary); font-size: 12.5px; }
.imw-pbody { display: none; border-top: 1px solid var(--border-subtle); padding: 12px 14px 14px; }
.imw-provider.open .imw-pbody { display: block; }
.imw-cards { display: flex; flex-direction: column; gap: 10px; }
.imw-card { border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; background: var(--surface); display: flex; flex-direction: column; gap: 8px; }
.imw-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.imw-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.imw-dot.connected { background: var(--success); box-shadow: 0 0 0 3px var(--success-soft); }
.imw-dot.disconnected { background: var(--text-tertiary); box-shadow: 0 0 0 3px var(--surface-subtle); }
.imw-dot.error { background: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }
.imw-dot.unknown { background: var(--warning); box-shadow: 0 0 0 3px var(--warning-soft); }
.imw-label { font-weight: 580; }
.imw-meta { color: var(--text-tertiary); font-size: 12px; }
.imw-pill { font-size: 11.5px; border-radius: 999px; padding: 1px 8px; font-weight: 560; border: 1px solid transparent; }
.imw-pill.connected { color: var(--success); background: var(--success-soft); }
.imw-pill.disconnected { color: var(--text-tertiary); background: var(--surface-subtle); border-color: var(--border-subtle); }
.imw-pill.error { color: var(--danger); background: var(--danger-soft); }
.imw-pill.unknown { color: var(--warning); background: var(--warning-soft); }
.imw-acts { margin-left: auto; display: flex; gap: 4px; }
.imw-bind { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding-top: 8px; border-top: 1px dashed var(--border-subtle); }
.imw-cap { font-size: 11.5px; color: var(--text-tertiary); }
.imw-schip { display: inline-flex; align-items: center; gap: 5px; background: var(--surface-subtle); border: 1px solid var(--border-subtle); border-radius: 999px; padding: 2px 9px; font-size: 12px; color: var(--text-secondary); }
.imw-schip .cid { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-tertiary); }
.imw-schip .sess { color: var(--text); }
.imw-empty { color: var(--text-tertiary); font-size: 12.5px; padding: 2px 0; }
.imw-events { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-raised); box-shadow: var(--shadow-soft); }
.imw-events > summary { cursor: pointer; padding: 11px 14px; font-size: 13px; font-weight: 560; color: var(--text-secondary); list-style: none; }
.imw-events > summary::-webkit-details-marker { display: none; }
.imw-log { border-top: 1px solid var(--border-subtle); padding: 8px 14px 12px; font-family: var(--font-mono); font-size: 12px; color: var(--text-secondary); max-height: 240px; overflow: auto; }
.imw-log div { padding: 2px 0; }
.imw-log .ts { color: var(--text-tertiary); margin-right: 8px; }
.imw-log .ok { color: var(--success); }
.imw-log .warn { color: var(--warning); }
.imw-log .err { color: var(--danger); }
/* 弹窗 */
.imw-mask { position: fixed; inset: 0; background: rgba(12,18,28,.45); display: none; align-items: flex-start; justify-content: center; padding: 8vh 20px 40px; z-index: 4000; }
.imw-mask.show { display: flex; }
.imw-modal { width: 100%; max-width: 560px; max-height: 80vh; display: flex; flex-direction: column; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-raised); overflow: hidden; }
.imw-mhead { display: flex; align-items: center; gap: 9px; padding: 12px 15px; border-bottom: 1px solid var(--border-subtle); }
.imw-mtitle { font-weight: 620; font-size: 14px; }
.imw-mtag { font-size: 11px; color: var(--accent-ink); background: var(--accent-soft); border-radius: 999px; padding: 1px 8px; font-weight: 560; }
.imw-mclose { margin-left: auto; border: none; background: transparent; color: var(--text-tertiary); font-size: 18px; line-height: 1; cursor: pointer; border-radius: 6px; padding: 0 6px; }
.imw-mclose:hover { background: var(--surface-hover); color: var(--text); }
.imw-mbody { padding: 14px 15px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.imw-mfoot { display: flex; align-items: center; gap: 8px; padding: 11px 15px; border-top: 1px solid var(--border-subtle); background: var(--surface-subtle); }
.imw-field { display: flex; flex-direction: column; gap: 4px; }
.imw-field > label { font-size: 12px; color: var(--text-secondary); }
.imw-field select, .imw-field input { font: inherit; font-size: 13px; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 5px 8px; width: 100%; }
.imw-row { display: flex; align-items: center; gap: 8px; }
.imw-slot { min-height: 120px; display: flex; flex-direction: column; gap: 8px; }
.imw-err { color: var(--danger); font-size: 12.5px; }
.imw-hint { font-size: 12px; color: var(--text-tertiary); }
`;
  document.head.append(style);
}

// ── 弹窗 ──────────────────────────────────────────────────────────────────

type ModalHandle = {
  close(): void;
  body: HTMLElement;
  head: HTMLElement;
  foot: HTMLElement;
  /** 注册卸载回调（挂载进来的渠道组件用）。 */
  onClose(fn: () => void): void;
};

function openModal(opts: { title: string; tag?: string }): ModalHandle {
  const mask = el('div', 'imw-mask');
  const modal = el('div', 'imw-modal');
  const head = el('div', 'imw-mhead');
  head.append(el('span', 'imw-mtitle', opts.title));
  if (opts.tag) head.append(el('span', 'imw-mtag', opts.tag));
  const closeBtn = el('button', 'imw-mclose', '×');
  closeBtn.type = 'button';
  head.append(closeBtn);
  const body = el('div', 'imw-mbody');
  const foot = el('div', 'imw-mfoot');
  modal.append(head, body, foot);
  mask.append(modal);
  document.body.append(mask);
  requestAnimationFrame(() => mask.classList.add('show'));

  let disposed = false;
  const close = (): void => {
    if (disposed) return;
    disposed = true;
    mask.classList.remove('show');
    mask.remove();
    document.removeEventListener('keydown', onKey);
    onClose.forEach((fn) => {
      try {
        fn();
      } catch {
        /* 卸载异常不影响页面 */
      }
    });
  };
  const onClose: Array<() => void> = [];
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  closeBtn.addEventListener('click', close);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });
  return { close, body, head, foot, onClose: (fn: () => void) => onClose.push(fn) };
}

// ── 新增连接（内容由渠道槽位提供）─────────────────────────────────────────

async function openCreate(channel: ChannelRow): Promise<void> {
  const surface = creatorFor(channel.providerId);
  if (!surface) return;
  const modal = openModal({ title: `新增连接 · ${channel.label}`, tag: `来自 ${channel.providerId}` });
  const slot = el('div', 'imw-slot');
  slot.textContent = '正在加载渠道组件…';
  modal.body.append(slot);
  modal.foot.append(
    button('取消', '', () => modal.close()),
  );

  const host: CreateHost = {
    done: () => {
      modal.close();
      void reload();
    },
    cancel: () => modal.close(),
    fail: (message: string) => {
      const err = el('div', 'imw-err', message);
      modal.body.append(err);
    },
  };

  try {
    // 装载地址来自服务端（`url`），不自己拼 `/plugins/<id>/web/<file>.js`。
    const mod = (await import(/* @vite-ignore */ surface.url)) as {
      mount?: (el: HTMLElement, host: CreateHost) => undefined | (() => void);
    };
    if (typeof mod.mount !== 'function') {
      throw new Error('渠道组件没有导出 mount(el, host)');
    }
    slot.textContent = '';
    const dispose = mod.mount(slot, host);
    if (typeof dispose === 'function') modal.onClose(dispose);
  } catch (err) {
    slot.textContent = '';
    slot.append(el('div', 'imw-err', `渠道组件加载失败：${err instanceof Error ? err.message : String(err)}`));
  }
}

// ── 编辑会话弹窗（网关渲染）───────────────────────────────────────────────

async function openBindings(conn: ConnectionRow): Promise<void> {
  const modal = openModal({ title: '编辑会话绑定', tag: conn.id });
  modal.body.append(el('div', 'imw-hint', '正在加载…'));

  const agents = await loadAgents();
  const agentId = conn.agentId ?? '';
  const sessions = agentId ? await loadSessions(agentId) : [];
  modal.body.textContent = '';

  const agentField = el('div', 'imw-field');
  agentField.append(el('label', undefined, '该连接使用的 agent'));
  const agentSel = el('select');
  agentSel.append(new Option('（未指定）', ''));
  for (const a of agents) agentSel.append(new Option(a.name ?? a.id, a.id, false, a.id === agentId));
  agentField.append(agentSel);

  const defaultField = el('div', 'imw-field');
  defaultField.append(el('label', undefined, '默认会话（未单独绑定的聊天走它）'));
  const defaultSel = el('select');
  defaultSel.append(new Option('不设置（按聊天自动新建会话）', '', false, !conn.defaultSessionId));
  for (const s of sessions) {
    defaultSel.append(new Option(s.title || s.id.slice(0, 8), s.id, false, s.id === conn.defaultSessionId));
  }
  defaultField.append(defaultSel);

  const list = el('div', 'imw-cards');
  const drafts = new Map<string, string>();
  for (const b of conn.bindings) {
    const card = el('div', 'imw-card');
    const line = el('div', 'imw-line');
    const idSpan = el('span', 'imw-meta');
    idSpan.textContent = b.chatId;
    line.append(idSpan);
    const acts = el('div', 'imw-acts');
    acts.append(
      button('解绑', 'danger', async () => {
        try {
          await apiJson(`${PREFIX}/bindings/${encodeURIComponent(conn.id)}/${encodeURIComponent(b.chatId)}`, {
            method: 'DELETE',
          });
          await reload();
          modal.close();
        } catch (err) {
          modal.body.append(el('div', 'imw-err', `解绑失败：${(err as Error).message}`));
        }
      }),
    );
    line.append(acts);
    const sel = el('select');
    sel.append(new Option('（未选择）', ''));
    for (const s of sessions) sel.append(new Option(s.title || s.id.slice(0, 8), s.id, false, s.id === b.sessionId));
    sel.addEventListener('change', () => drafts.set(b.chatId, sel.value));
    card.append(line, sel);
    list.append(card);
  }
  if (conn.bindings.length === 0) {
    list.append(el('div', 'imw-empty', '还没有收到消息 —— 有人发过消息后，这里会出现可绑定的聊天。'));
  }

  // 手动添加聊天（chatId 可从渠道日志 / 外部系统拿到）
  const manual = el('div', 'imw-card');
  const manualLine = el('div', 'imw-row');
  const chatIn = el('input');
  chatIn.placeholder = '外部会话 id（chatId）';
  const manualSel = el('select');
  manualSel.append(new Option('选择会话…', ''));
  for (const s of sessions) manualSel.append(new Option(s.title || s.id.slice(0, 8), s.id));
  manualLine.append(chatIn, manualSel);
  const manualCap = el('div', 'imw-hint', '先手动绑定：消息还没来过时，也能把某个聊天接到指定会话。');
  manual.append(manualCap, manualLine);

  modal.body.append(agentField, defaultField, list, manual);
  modal.foot.append(
    el('span', 'imw-spacer'),
    button('取消', '', () => modal.close()),
    button('保存', 'primary', async () => {
      const errs: string[] = [];
      try {
        // ① 换 agent：会作废该连接的绑定与默认会话 → 必须显式确认
        if (agentSel.value && agentSel.value !== (conn.agentId ?? '')) {
          const ok = window.confirm(
            '换 agent 会清空这条连接的全部会话绑定与默认会话（旧会话属于上一个 agent）。继续？',
          );
          if (!ok) return;
          await apiJson(`${PREFIX}/connections/${encodeURIComponent(conn.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ agentId: agentSel.value }),
          });
          await reload();
          modal.close();
          return;
        }
        // ② 默认会话
        if ((defaultSel.value || null) !== (conn.defaultSessionId ?? null)) {
          await apiJson(`${PREFIX}/connections/${encodeURIComponent(conn.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ defaultSessionId: defaultSel.value || null }),
          });
        }
        // ③ 每条聊天的会话
        for (const [chatId, sessionId] of drafts) {
          if (!sessionId) continue;
          await apiJson(`${PREFIX}/bindings/${encodeURIComponent(conn.id)}/${encodeURIComponent(chatId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ sessionId }),
          });
        }
        // ④ 手动新增绑定
        const manualChat = chatIn.value.trim();
        if (manualChat && manualSel.value) {
          await apiJson(
            `${PREFIX}/bindings/${encodeURIComponent(conn.id)}/${encodeURIComponent(manualChat)}`,
            { method: 'PATCH', body: JSON.stringify({ sessionId: manualSel.value }) },
          );
        }
      } catch (err) {
        errs.push((err as Error).message);
      }
      if (errs.length > 0) {
        modal.body.append(el('div', 'imw-err', `保存失败：${errs.join('；')}`));
        return;
      }
      await reload();
      modal.close();
    }),
  );
}

// ── 页面渲染 ──────────────────────────────────────────────────────────────

const STATUS_TEXT: Record<ConnectionRow['status'], string> = {
  connected: '已连接',
  disconnected: '未连接',
  error: '连接失败',
  unknown: '初始化中',
};

let root: HTMLElement | null = null;
let logBox: HTMLElement | null = null;

async function reload(): Promise<void> {
  try {
    await refresh();
  } catch (err) {
    if (root) {
      root.textContent = '';
      root.append(el('div', 'imw-err', `加载失败：${(err as Error).message}`));
    }
    return;
  }
  void preloadSessionTitles();
  render();
}

/**
 * 预取各连接的会话标题（chips 上要显示人看得懂的名字，不是 sessionId 前 8 位）。
 * 有绑定的连接才取，且按 agent 去重 —— 一次页面最多几个请求。
 */
async function preloadSessionTitles(): Promise<void> {
  const agentIds = new Set(
    state.connections.filter((c) => c.agentId && c.bindings.length > 0).map((c) => c.agentId as string),
  );
  if (agentIds.size === 0) return;
  await Promise.all([...agentIds].map((id) => loadSessions(id).catch(() => [])));
  render();
}

function render(): void {
  if (!root) return;
  root.textContent = '';

  const wrap = el('div', 'imw');
  root.append(wrap);

  const totalOnline = state.connections.filter((c) => c.status === 'connected').length;
  const totalBindings = state.connections.reduce((n, c) => n + c.bindings.length, 0);
  const head = el('div', 'imw-head');
  head.append(
    el('h2', undefined, 'IM 网关'),
    el(
      'span',
      'imw-sub',
      `${state.channels.length} 个渠道 · ${state.connections.length} 条连接 · ${totalOnline} 在线 · ${totalBindings} 条会话绑定`,
    ),
  );
  wrap.append(head);

  // 渠道卡：按 channel 列表分组（没有连接的渠道也要有一张卡，否则无处新增）
  const byProvider = new Map<string, ConnectionRow[]>();
  for (const c of state.connections) {
    const list = byProvider.get(c.providerId) ?? [];
    list.push(c);
    byProvider.set(c.providerId, list);
  }
  const channels = [...state.channels].sort((a, b) => a.label.localeCompare(b.label));
  for (const ch of channels) {
    wrap.append(renderProvider(ch, byProvider.get(ch.providerId) ?? []));
  }
  if (channels.length === 0) {
    wrap.append(
      el('div', 'imw-empty', '还没有装载任何 IM 渠道插件。装一个（提供 im.channel 服务）就会出现在这里。'),
    );
  }

  // 事件流（折叠）
  const events = el('details', 'imw-events');
  events.append(el('summary', undefined, '事件流'));
  logBox = el('div', 'imw-log');
  events.append(logBox);
  wrap.append(events);
}

function renderProvider(channel: ChannelRow, connections: ConnectionRow[]): HTMLElement {
  const card = el('section', `imw-provider${state.collapsed.has(channel.providerId) ? '' : ' open'}`);
  const head = el('div', 'imw-phead');
  head.append(el('span', 'imw-chev', '▶'));
  const badge = el('div', 'imw-badge', (channel.label || channel.type || '?').slice(0, 1).toUpperCase());
  head.append(badge);
  head.append(el('span', 'imw-pname', channel.label || channel.type));
  head.append(el('span', 'imw-chip', channel.providerId));

  const online = connections.filter((c) => c.status === 'connected').length;
  const meta = el('div', 'imw-acts');
  meta.append(el('span', 'imw-count', `${connections.length} 条连接 · ${online} 在线`));
  const surface = creatorFor(channel.providerId);
  const addBtn = button('＋ 新增连接', 'primary', () => void openCreate(channel));
  if (!surface) {
    addBtn.disabled = true;
    addBtn.title = '该渠道没有注册 im.channel.create 槽位（请手工改它的配置，或让作者补上）';
  }
  meta.append(addBtn);
  head.append(meta);
  card.append(head);

  head.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const open = card.classList.toggle('open');
    if (open) state.collapsed.delete(channel.providerId);
    else state.collapsed.add(channel.providerId);
  });

  const body = el('div', 'imw-pbody');
  if (connections.length === 0) {
    body.append(el('div', 'imw-empty', '还没有连接。'));
  }
  const cards = el('div', 'imw-cards');
  for (const conn of connections) cards.append(renderConnection(conn));
  body.append(cards);
  card.append(body);
  return card;
}

function renderConnection(conn: ConnectionRow): HTMLElement {
  const card = el('div', 'imw-card');
  const line = el('div', 'imw-line');
  line.append(el('span', `imw-dot ${conn.status}`));
  line.append(el('span', 'imw-label', conn.id));
  line.append(el('span', `imw-pill ${conn.status}`, STATUS_TEXT[conn.status]));
  if (conn.lastError) line.append(el('span', 'imw-meta', conn.lastError));
  if (conn.agentId) {
    const agentName = state.agents.find((a) => a.id === conn.agentId)?.name ?? conn.agentId;
    line.append(el('span', 'imw-meta', `agent · ${agentName}`));
  } else {
    line.append(el('span', 'imw-meta', '未指定 agent'));
  }

  const acts = el('div', 'imw-acts');
  acts.append(
    button(conn.enabled ? '停用' : '启用', 'ghost', async () => {
      try {
        await apiJson(`${PREFIX}/connections/${encodeURIComponent(conn.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ enabled: !conn.enabled }),
        });
        await reload();
      } catch (err) {
        line.append(el('span', 'imw-err', (err as Error).message));
      }
    }),
  );
  const del = button('删除', 'danger', async () => {
    const ok = window.confirm(`删除连接 ${conn.id}？渠道配置里的条目与它名下的会话绑定都会清掉。`);
    if (!ok) return;
    try {
      await apiJson(`${PREFIX}/connections/${encodeURIComponent(conn.id)}`, { method: 'DELETE' });
      await reload();
    } catch (err) {
      line.append(el('span', 'imw-err', `删除失败：${(err as Error).message}`));
    }
  });
  if (!conn.canRemove) {
    del.disabled = true;
    del.title = '该渠道没有提供删除能力（driver.remove），请手工修改它的配置文件';
  }
  acts.append(del);
  line.append(acts);
  card.append(line);

  const bind = el('div', 'imw-bind');
  bind.append(el('span', 'imw-cap', '会话'));
  if (conn.bindings.length === 0) {
    bind.append(el('span', 'imw-empty', conn.enabled ? '还没有收到消息' : '已停用'));
  }
  for (const b of conn.bindings) {
    const chip = el('span', 'imw-schip');
    const cid = el('span', 'cid', b.chatId);
    const sess = el('span', 'sess', sessionTitle(b.sessionId));
    chip.append(cid, el('span', 'imw-cap', '→'), sess);
    bind.append(chip);
  }
  const actions = el('div', 'imw-acts');
  actions.append(button('编辑会话', '', () => void openBindings(conn)));
  bind.append(actions);
  card.append(bind);
  return card;
}

function sessionTitle(sessionId: string): string {
  for (const list of state.sessionCache.values()) {
    const hit = list.find((s) => s.id === sessionId);
    if (hit) return hit.title || hit.id.slice(0, 8);
  }
  return sessionId.slice(0, 8);
}

// ── 事件流（SSE）─────────────────────────────────────────────────────────

function subscribeLogs(): () => void {
  let es: EventSource | null = null;
  try {
    es = new EventSource(`${PREFIX}/events`);
  } catch {
    return () => undefined;
  }
  es.addEventListener('channel-log', (evt) => {
    if (!logBox) return;
    let data: { level?: string; message?: string; ts?: number; providerId?: string; connectionId?: string } = {};
    try {
      data = JSON.parse((evt as MessageEvent).data as string) as typeof data;
    } catch {
      return;
    }
    const row = el('div');
    const ts = data.ts ? new Date(data.ts).toLocaleTimeString() : '';
    const cls = data.level === 'error' ? 'err' : data.level === 'warn' ? 'warn' : 'ok';
    row.append(el('span', 'ts', ts), el('span', cls, data.level ?? 'info'), document.createTextNode(` ${data.message ?? ''}`));
    logBox.append(row);
    while (logBox.childElementCount > 200) logBox.firstElementChild?.remove();
  });
  return () => es?.close();
}

// ── 挂载 ──────────────────────────────────────────────────────────────────

export function mount(hostEl: HTMLElement, _host?: WebHost): () => void {
  ensureStyle();
  const container = el('div');
  container.style.height = '100%';
  hostEl.append(container);
  root = container;

  void (async () => {
    await loadAgents();
    await reload();
  })();
  const disposeLogs = subscribeLogs();

  return () => {
    disposeLogs();
    state.sessionCache.clear();
    root = null;
    logBox = null;
    hostEl.textContent = '';
  };
}
