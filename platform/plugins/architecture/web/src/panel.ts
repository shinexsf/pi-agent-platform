/**
 * 顶栏「架构图」面板（R11）—— 图列表。
 *
 * 为什么面板只是列表、不嵌 iframe：archify 产物是 ~840K 的自包含页面（自带主题、
 * 播放、导出工具），塞进顶栏浮层既慢又挤。所以沿用通知插件的形状：
 * **图标 → 面板里选一张 → 整页看**（`/architecture?set=&d=`，`nav: false` 的正式页面）。
 *
 * 数据来自本插件的 `GET /manifest`（清单只在 server facet 里维护一份，浏览器不硬编码图名）。
 */

interface Diagram {
  slug: string;
  label: string;
  hint: string;
  type: string;
  file: string;
}

interface Collection {
  id: string;
  label: string;
  hint: string;
  emptyHint: string;
  diagrams: Diagram[];
}

interface HostWithApi {
  api: { get(p: string): Promise<unknown> };
  ui: { navigate(path: string): void };
}

const TYPE_LABEL: Record<string, string> = {
  architecture: '架构',
  sequence: '时序',
  workflow: '流程',
  dataflow: '数据流',
  lifecycle: '状态机',
  erd: 'ERD',
  tree: '树',
  class: '类图',
  timeline: '时间线',
  waterfall: '瀑布',
};

function style(): string {
  return `
    .arc-panel { width: 340px; max-height: min(70vh, 520px); display: flex; flex-direction: column; }
    .arc-head { display: flex; align-items: baseline; gap: 8px; padding: 12px 14px 8px; }
    .arc-title { font-size: 13px; font-weight: 600; color: var(--text); margin: 0; }
    .arc-sub { font-size: 12px; color: var(--text-tertiary); }
    .arc-body { overflow-y: auto; padding: 0 8px 10px; }
    .arc-group + .arc-group { margin-top: 6px; }
    .arc-group-title { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--text-tertiary); padding: 8px 6px 4px; }
    .arc-item { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; background: none;
      border: 1px solid transparent; border-radius: var(--radius-md); padding: 7px 8px; cursor: pointer; color: var(--text); }
    .arc-item:hover { background: var(--surface-hover); border-color: var(--border-subtle); }
    .arc-item:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
    .arc-item-top { display: flex; align-items: center; gap: 6px; }
    .arc-item-label { font-size: 13px; font-weight: 500; }
    .arc-tag { font-size: 10px; padding: 1px 5px; border-radius: 999px; background: var(--surface-subtle);
      color: var(--text-secondary); border: 1px solid var(--border-subtle); }
    .arc-item-hint { font-size: 11.5px; color: var(--text-secondary); line-height: 1.4; }
    .arc-empty { padding: 10px 14px 14px; font-size: 12px; color: var(--text-tertiary); }
    .arc-error { padding: 12px 14px; font-size: 12px; color: var(--danger); }
  `;
}

export function mount(el: HTMLElement, host: HostWithApi): () => void {
  let disposed = false;

  const styleEl = document.createElement('style');
  styleEl.textContent = style();

  const wrap = document.createElement('div');
  wrap.className = 'arc-panel';
  wrap.innerHTML = `
    <header class="arc-head">
      <h2 class="arc-title">架构图</h2>
      <span class="arc-sub">选一张看整页</span>
    </header>
    <div class="arc-body" data-role="body"></div>
  `;
  el.appendChild(styleEl);
  el.appendChild(wrap);

  const body = wrap.querySelector('[data-role="body"]') as HTMLElement;

  const openDiagram = (collectionId: string, slug: string): void => {
    host.ui.navigate(`/architecture?set=${encodeURIComponent(collectionId)}&d=${encodeURIComponent(slug)}`);
  };

  void (async () => {
    try {
      const data = (await host.api.get('/manifest')) as { collections?: Collection[] } | null;
      if (disposed) return;
      const collections = data?.collections ?? [];
      body.innerHTML = '';

      if (collections.every((c) => c.diagrams.length === 0)) {
        const empty = document.createElement('p');
        empty.className = 'arc-empty';
        empty.textContent = '还没有图';
        body.appendChild(empty);
        return;
      }

      for (const collection of collections) {
        const group = document.createElement('div');
        group.className = 'arc-group';

        const title = document.createElement('div');
        title.className = 'arc-group-title';
        title.textContent = `${collection.label} · ${collection.diagrams.length}`;
        title.title = collection.hint;
        group.appendChild(title);

        for (const diagram of collection.diagrams) {
          const item = document.createElement('button');
          item.type = 'button';
          item.className = 'arc-item';
          item.innerHTML = `
            <span class="arc-item-top">
              <span class="arc-item-label"></span>
              <span class="arc-tag"></span>
            </span>
            <span class="arc-item-hint"></span>
          `;
          (item.querySelector('.arc-item-label') as HTMLElement).textContent = diagram.label;
          (item.querySelector('.arc-tag') as HTMLElement).textContent = TYPE_LABEL[diagram.type] ?? diagram.type;
          (item.querySelector('.arc-item-hint') as HTMLElement).textContent = diagram.hint;
          item.title = `${diagram.label} — ${diagram.hint}`;
          item.addEventListener('click', () => openDiagram(collection.id, diagram.slug));
          group.appendChild(item);
        }

        body.appendChild(group);
      }
    } catch (err) {
      if (disposed) return;
      body.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'arc-error';
      p.textContent = `清单加载失败：${(err as Error).message}`;
      body.appendChild(p);
    }
  })();

  return () => {
    disposed = true;
    styleEl.remove();
    wrap.remove();
  };
}
