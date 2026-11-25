/**
 * 架构图整页宿主（R1 页面，`nav: false`）。
 *
 * 两级切换器（集合 × 图）+ iframe 承载 archify 产物。
 *
 * 为什么用 iframe：archify 产物自带 theme / 样式 / 播放与导出工具，塞进 SPA 会跟
 * 应用外壳的样式打架（它甚至有自己的一套 CSS 变量与快捷键）。独立 document 是唯一稳的隔离方式。
 *
 * URL：`/architecture?set=<collectionId>&d=<slug>`
 * - 只给 `d=` 的老链接按 slug 反查集合（所以 slug 必须全局唯一）
 * - 每个集合记住上次看的那张图（localStorage），切回来不跳回第一张
 *
 * 位置：`position: fixed; top: var(--app-header-h)` —— 平台给插件页的是带 padding 的
 * 容器，而这里的 iframe 要撑满视口剩余高度。平台承诺的 `--app-header-h` 是白名单变量。
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
}

const STORAGE_PREFIX = 'pi-web-architecture:';

function style(): string {
  return `
    .arc { position: fixed; top: var(--app-header-h); right: 0; bottom: 0; left: 0;
      display: flex; flex-direction: column; background: var(--bg); color: var(--text); z-index: 1; }
    .arc-bar { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 14px 0; }
    .arc-sets { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--radius-md); background: var(--surface-subtle); }
    .arc-set { appearance: none; border: 0; background: none; cursor: pointer; font: inherit; font-size: 12px;
      padding: 4px 10px; border-radius: var(--radius-sm); color: var(--text-secondary); }
    .arc-set:hover { color: var(--text); }
    .arc-set[aria-selected="true"] { background: var(--surface); color: var(--text); box-shadow: var(--shadow-soft); }
    .arc-tabs { flex: 1; min-width: 0; display: flex; gap: 4px; overflow-x: auto; scrollbar-width: thin; }
    .arc-tab { appearance: none; flex: none; border: 1px solid transparent; background: none; cursor: pointer;
      font: inherit; font-size: 12px; padding: 4px 9px; border-radius: var(--radius-sm); color: var(--text-secondary); }
    .arc-tab:hover { background: var(--surface-hover); color: var(--text); }
    .arc-tab[aria-current="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
    .arc-hint { flex: 1; min-width: 0; font-size: 12px; color: var(--text-tertiary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .arc-frame-wrap { flex: 1; min-height: 0; padding: 8px 0 0; display: flex; }
    .arc-frame { flex: 1; min-height: 0; width: 100%; border: 0; background: var(--surface); }
    .arc-placeholder { margin: auto; padding: 24px; text-align: center; font-size: 13px; color: var(--text-secondary); }
    .arc-placeholder code { font-family: var(--font-mono); font-size: 12px; background: var(--code-inline-bg);
      border: 1px solid var(--code-border); border-radius: var(--radius-sm); padding: 1px 5px; }
    @media (max-width: 640px) {
      .arc-bar { flex-wrap: wrap; padding: 6px 10px 0; }
      .arc-hint { display: none; }
    }
  `;
}

export function mount(el: HTMLElement, host: HostWithApi): () => void {
  let disposed = false;
  let collections: Collection[] = [];
  let onPop: (() => void) | null = null;

  const readRemembered = (collectionId: string): string | null => {
    try {
      return localStorage.getItem(`${STORAGE_PREFIX}${collectionId}`);
    } catch {
      return null;
    }
  };

  const remember = (collectionId: string, slug: string): void => {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${collectionId}`, slug);
    } catch {
      /* localStorage 不可用（隐私模式）时忽略 */
    }
  };

  const styleEl = document.createElement('style');
  styleEl.textContent = style();

  const root = document.createElement('div');
  root.className = 'arc';
  root.innerHTML = `
    <div class="arc-bar">
      <div class="arc-sets" role="tablist" data-role="sets"></div>
      <div class="arc-tabs" role="tablist" data-role="tabs"></div>
      <span class="arc-hint" data-role="hint"></span>
    </div>
    <div class="arc-frame-wrap" data-role="stage"></div>
  `;
  el.appendChild(styleEl);
  el.appendChild(root);

  const setsEl = root.querySelector('[data-role="sets"]') as HTMLElement;
  const tabsEl = root.querySelector('[data-role="tabs"]') as HTMLElement;
  const hintEl = root.querySelector('[data-role="hint"]') as HTMLElement;
  const stageEl = root.querySelector('[data-role="stage"]') as HTMLElement;

  /** slug → 所属集合（老链接只带 `d=`）。 */
  const collectionOfSlug = (slug: string): Collection | undefined =>
    collections.find((c) => c.diagrams.some((d) => d.slug === slug));

  const currentQuery = (): { set?: string; d?: string } => {
    const params = new URLSearchParams(window.location.search);
    return { set: params.get('set') ?? undefined, d: params.get('d') ?? undefined };
  };

  /** 解析"现在该看哪张图"，顺序：URL → 该集合记住的 → 集合第一张。 */
  const resolveView = (): { collection: Collection; diagram: Diagram | null } => {
    const { set, d } = currentQuery();
    const bySlug = d ? collectionOfSlug(d) : undefined;
    const collection =
      (set ? collections.find((c) => c.id === set) : undefined) ??
      bySlug ??
      collections[0] ??
      { id: '', label: '', hint: '', emptyHint: '还没有图', diagrams: [] };

    if (!collection.diagrams.length) return { collection, diagram: null };

    const wanted = d && collection.diagrams.some((x) => x.slug === d) ? d : null;
    if (wanted) {
      const found = collection.diagrams.find((x) => x.slug === wanted) ?? null;
      return { collection, diagram: found };
    }
    const rememberedSlug = readRemembered(collection.id);
    const remembered = rememberedSlug
      ? collection.diagrams.find((x) => x.slug === rememberedSlug)
      : undefined;
    return { collection, diagram: remembered ?? collection.diagrams[0] ?? null };
  };

  const syncUrl = (collectionId: string, slug: string | null): void => {
    const params = new URLSearchParams(window.location.search);
    params.set('set', collectionId);
    if (slug) params.set('d', slug);
    else params.delete('d');
    const next = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(window.history.state, '', next);
  };

  const render = (): void => {
    const { collection, diagram } = resolveView();

    // 集合选择器
    setsEl.innerHTML = '';
    for (const c of collections) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'arc-set';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(c.id === collection.id));
      btn.textContent = c.label;
      btn.title = c.hint;
      btn.addEventListener('click', () => {
        const next = readRemembered(c.id) ?? c.diagrams[0]?.slug ?? null;
        go(c.id, next);
      });
      setsEl.appendChild(btn);
    }
    setsEl.hidden = collections.length <= 1;

    // 图 tabs
    tabsEl.innerHTML = '';
    for (const d of collection.diagrams) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'arc-tab';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-current', String(d.slug === diagram?.slug));
      btn.textContent = d.label;
      btn.title = `${d.label} — ${d.hint}`;
      btn.addEventListener('click', () => go(collection.id, d.slug));
      tabsEl.appendChild(btn);
    }
    tabsEl.hidden = collection.diagrams.length <= 1;

    hintEl.textContent = diagram?.hint ?? collection.hint;

    // 舞台
    stageEl.innerHTML = '';
    if (!diagram) {
      const p = document.createElement('p');
      p.className = 'arc-placeholder';
      p.textContent = collection.emptyHint || '还没有图';
      stageEl.appendChild(p);
      return;
    }
    const frame = document.createElement('iframe');
    frame.className = 'arc-frame';
    frame.title = diagram.label;
    frame.src = `/api/p/architecture/diagram/${encodeURIComponent(diagram.file)}`;
    stageEl.appendChild(frame);
  };

  const go = (collectionId: string, slug: string | null): void => {
    if (slug) remember(collectionId, slug);
    syncUrl(collectionId, slug);
    render();
  };

  void (async () => {
    try {
      const data = (await host.api.get('/manifest')) as { collections?: Collection[] } | null;
      if (disposed) return;
      collections = data?.collections ?? [];
      // 首屏把 URL 补齐（老链接只带 d=、或完全没参数），刷新/分享都能复现当前这张
      const { collection, diagram } = resolveView();
      if (collection.id) syncUrl(collection.id, diagram?.slug ?? null);
      if (diagram) remember(collection.id, diagram.slug);
      render();

      onPop = () => render();
      window.addEventListener('popstate', onPop);
    } catch (err) {
      if (disposed) return;
      stageEl.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'arc-placeholder';
      p.textContent = `清单加载失败：${(err as Error).message}`;
      stageEl.appendChild(p);
    }
  })();

  return () => {
    disposed = true;
    if (onPop) window.removeEventListener('popstate', onPop);
    styleEl.remove();
    root.remove();
  };
}
