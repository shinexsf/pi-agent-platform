/**
 * 平台状态页（admin 插件的 web facet）。
 *
 * 只读：版本 / uptime / 端口 / worker 池 + 计数。数据来自插件自己的 `GET /status`
 * （手写路由，常开）；动作的 HTTP 面是 POST + 全局开关，不适合给页面用。
 *
 * 主题只用平台承诺的 CSS 变量（`PLATFORM_THEME_VARS`）—— 换主题时页面自动跟随。
 */

interface StatusPayload {
  runtime: {
    version: string;
    uptimeMs: number;
    nodeEnv: string;
    port: number;
    pid: number;
    workers: { active: number; placeholders: number; max: number; pendingCalls: number };
  };
  counts: { agents: number; sessions: number; actions: number };
}

const CSS = `
.adm-wrap { padding: 20px 24px; color: var(--text); font-size: 13px; }
.adm-title { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
.adm-sub { color: var(--text-secondary); margin: 0 0 18px; }
.adm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; max-width: 900px; }
.adm-card { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; background: var(--surface); }
.adm-label { color: var(--text-secondary); font-size: 12px; margin-bottom: 6px; }
.adm-value { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.adm-err { color: var(--danger); }
`;

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

export function mount(el: HTMLElement): () => void {
  const style = document.createElement('style');
  style.textContent = CSS;
  const wrap = document.createElement('div');
  wrap.className = 'adm-wrap';
  wrap.innerHTML = '<h2 class="adm-title">平台状态</h2><p class="adm-sub">只读快照，来自 admin 插件的 <code>GET /status</code>。</p><div class="adm-grid">加载中…</div>';
  el.append(style, wrap);

  const grid = wrap.querySelector('.adm-grid') as HTMLElement;
  let disposed = false;

  const render = (data: StatusPayload): void => {
    const w = data.runtime.workers;
    const cells: Array<[string, string]> = [
      ['版本', data.runtime.version],
      ['运行时长', fmtUptime(data.runtime.uptimeMs)],
      ['端口', String(data.runtime.port)],
      ['环境', data.runtime.nodeEnv],
      ['worker（活跃）', String(w.active)],
      ['worker（占位）', String(w.placeholders)],
      ['池上限', String(w.max)],
      ['在飞调用', String(w.pendingCalls)],
      ['agents', String(data.counts.agents)],
      ['sessions', String(data.counts.sessions)],
      ['admin 动作', String(data.counts.actions)],
    ];
    grid.innerHTML = cells
      .map(([label, value]) => `<div class="adm-card"><div class="adm-label">${label}</div><div class="adm-value">${value}</div></div>`)
      .join('');
  };

  const load = async (): Promise<void> => {
    try {
      const res = await fetch('/api/p/admin/status');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!disposed) render((await res.json()) as StatusPayload);
    } catch (err) {
      if (!disposed) grid.innerHTML = `<div class="adm-err">读取失败：${(err as Error).message}</div>`;
    }
  };

  void load();
  // 页面停留期间轻量轮询：池统计是事实，不该只有刷新才准。
  const timer = setInterval(() => void load(), 5000);

  return () => {
    disposed = true;
    clearInterval(timer);
    style.remove();
    wrap.remove();
  };
}
