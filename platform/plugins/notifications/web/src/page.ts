/**
 * 通知收件箱**正式页面**（`/notifications`，`nav: false` 注册，入口在顶栏铃铛面板里）。
 *
 * 与 `panel.ts`（顶栏快速面板）同一形状、同一数据源，差别只有：列表不限条数、没有「查看全部」。
 *
 * 纯 DOM：平台不替插件编译 TS，也不给插件框架运行时（插件不能 import vue —— 浏览器没有
 * import map，而且两边各带一份框架会互不共享实例）。一个列表页用原生 DOM 完全够。
 *
 * 数据全部走本插件自己的端点 `/api/p/notifications/`（`host.api` 已带前缀）。
 */

interface NotificationItem {
  id: string;
  severity: 'info' | 'warning' | 'error';
  title: string;
  body: string;
  source: string;
  actionUrl?: string | null;
  readAt?: number | null;
  createdAt: number;
}

interface HostWithUi {
  api: { get(p: string): Promise<unknown>; post(p: string, body?: unknown): Promise<unknown> };
  ui: { navigate(path: string): void };
}

interface ListResponse {
  items: NotificationItem[];
  unreadCount: number;
}

const SEVERITY_LABEL: Record<NotificationItem['severity'], string> = {
  info: '信息',
  warning: '警告',
  error: '错误',
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function mount(el: HTMLElement, host: HostWithUi): () => void {
  let unreadOnly = false;
  let severity: '' | NotificationItem['severity'] = '';
  let disposed = false;

  el.innerHTML = `
    <div class="ntf">
      <header class="ntf-head">
        <h2 class="ntf-title">通知</h2>
        <span class="ntf-badge" data-role="badge" hidden></span>
        <div class="ntf-actions">
          <label class="ntf-check"><input type="checkbox" data-role="unread" /> 只看未读</label>
          <select class="ntf-select" data-role="severity">
            <option value="">全部级别</option>
            <option value="info">信息</option>
            <option value="warning">警告</option>
            <option value="error">错误</option>
          </select>
          <button class="ntf-btn" data-role="read-all">全部已读</button>
        </div>
      </header>
      <ul class="ntf-list" data-role="list"></ul>
      <p class="ntf-empty" data-role="empty" hidden>没有通知</p>

    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    .ntf { display: flex; flex-direction: column; gap: 12px; }
    .ntf-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .ntf-title { margin: 0; font-size: 16px; font-weight: 600; }
    .ntf-badge { font-size: 12px; padding: 1px 7px; border-radius: 999px; background: var(--danger-bg, #fee2e2); color: var(--danger, #b91c1c); }
    .ntf-actions { margin-left: auto; display: flex; align-items: center; gap: 10px; }
    .ntf-check { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; color: var(--text-dim, #6b7280); }
    .ntf-select, .ntf-btn { font-size: 13px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--border, #e5e7eb); background: var(--surface, #fff); color: inherit; }
    .ntf-btn { cursor: pointer; }
    .ntf-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .ntf-item { border: 1px solid var(--border, #e5e7eb); border-radius: 8px; padding: 10px 12px; display: flex; gap: 10px; align-items: flex-start; }
    .ntf-item[data-unread="1"] { border-left: 3px solid var(--accent, #2563eb); }
    .ntf-item[data-severity="error"] { border-left-color: var(--danger, #b91c1c); }
    .ntf-item[data-severity="warning"] { border-left-color: var(--warning, #d97706); }
    .ntf-body { flex: 1; min-width: 0; }
    .ntf-item-title { font-weight: 600; font-size: 14px; margin-bottom: 2px; }
    .ntf-item-text { font-size: 13px; color: var(--text-dim, #6b7280); white-space: pre-wrap; word-break: break-word; }
    .ntf-meta { display: flex; gap: 8px; font-size: 12px; color: var(--text-dim, #6b7280); margin-top: 6px; }
    .ntf-sev { padding: 0 6px; border-radius: 4px; background: var(--surface-alt, #f3f4f6); }
    .ntf-empty { color: var(--text-dim, #6b7280); font-size: 13px; }
    .ntf-foot { display: flex; justify-content: flex-end; border-top: 1px solid var(--border, #e5e7eb); padding-top: 8px; }
    .ntf-link { border: 0; background: transparent; color: var(--accent, #2563eb); font-size: 13px; cursor: pointer; padding: 2px 4px; }
    .ntf-link:hover { text-decoration: underline; }
  `;
  el.appendChild(style);

  const listEl = el.querySelector('[data-role="list"]') as HTMLUListElement;
  const emptyEl = el.querySelector('[data-role="empty"]') as HTMLElement;
  const badgeEl = el.querySelector('[data-role="badge"]') as HTMLElement;

  function render(items: NotificationItem[], unreadCount: number): void {
    badgeEl.hidden = unreadCount === 0;
    badgeEl.textContent = `${unreadCount} 未读`;
    emptyEl.hidden = items.length > 0;
    listEl.replaceChildren(
      ...items.map((item) => {
        const li = document.createElement('li');
        li.className = 'ntf-item';
        li.dataset.unread = item.readAt ? '0' : '1';
        li.dataset.severity = item.severity;

        const body = document.createElement('div');
        body.className = 'ntf-body';

        const title = document.createElement('div');
        title.className = 'ntf-item-title';
        title.textContent = item.title || '(无标题)';

        const text = document.createElement('div');
        text.className = 'ntf-item-text';
        text.textContent = item.body;

        const meta = document.createElement('div');
        meta.className = 'ntf-meta';
        const sev = document.createElement('span');
        sev.className = 'ntf-sev';
        sev.textContent = SEVERITY_LABEL[item.severity] ?? item.severity;
        const src = document.createElement('span');
        src.textContent = item.source;
        const when = document.createElement('span');
        when.textContent = relativeTime(item.createdAt);
        meta.append(sev, src, when);

        body.append(title, text, meta);
        li.appendChild(body);

        if (!item.readAt) {
          const btn = document.createElement('button');
          btn.className = 'ntf-btn';
          btn.textContent = '标为已读';
          btn.addEventListener('click', () => {
            void host.api.post(`/${encodeURIComponent(item.id)}/read`).then(load);
          });
          li.appendChild(btn);
        }
        return li;
      }),
    );
  }

  async function load(): Promise<void> {
    const params = new URLSearchParams();
    if (unreadOnly) params.set('unread', '1');
    if (severity) params.set('severity', severity);
    const qs = params.toString();
    try {
      const res = (await host.api.get(`/${qs ? `?${qs}` : ''}`)) as ListResponse;
      if (disposed) return;
      render(res.items ?? [], res.unreadCount ?? 0);
    } catch (err) {
      if (disposed) return;
      emptyEl.hidden = false;
      emptyEl.textContent = `加载失败：${String(err)}`;
    }
  }

  const unreadInput = el.querySelector('[data-role="unread"]') as HTMLInputElement;
  const severitySelect = el.querySelector('[data-role="severity"]') as HTMLSelectElement;
  const readAllBtn = el.querySelector('[data-role="read-all"]') as HTMLButtonElement;

  const onUnread = (): void => {
    unreadOnly = unreadInput.checked;
    void load();
  };
  const onSeverity = (): void => {
    severity = severitySelect.value as '' | NotificationItem['severity'];
    void load();
  };
  const onReadAll = (): void => {
    void host.api.post('/read-all').then(load);
  };

  unreadInput.addEventListener('change', onUnread);
  severitySelect.addEventListener('change', onSeverity);
  readAllBtn.addEventListener('click', onReadAll);

  void load();

  return () => {
    disposed = true;
    unreadInput.removeEventListener('change', onUnread);
    severitySelect.removeEventListener('change', onSeverity);
    readAllBtn.removeEventListener('click', onReadAll);
    el.replaceChildren();
  };
}
