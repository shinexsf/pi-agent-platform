/**
 * 「新增连接」组件的参考实现（插件空间槽位 `im.channel.create`）。
 *
 * 宿主（IM 网关页）拉 `GET /api/extensions` → 找到本插件的注册项 → `import(url)` →
 * `mount(el, host)`。契约只有三件事：
 *   - 自己渲染流程（扫码 / 表单 / OAuth…平台不关心）
 *   - 完成后调 `host.done()`（宿主据此重拉列表并关闭弹窗）
 *   - 用户取消调 `host.cancel()`；出错调 `host.fail(msg)`
 *
 * 产物约束：原生 ESM、无裸说明符、无 node 内建（要依赖就自己 bundle，见 SKILL §4.4）。
 */
export function mount(root, host) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:12px;color:var(--text-tertiary);';
  hint.textContent = 'Mock 渠道：填一个连接 id 就创建。';

  const input = document.createElement('input');
  input.placeholder = '如 mock-main';
  input.style.cssText =
    'font:inherit;font-size:13px;color:var(--text);background:var(--surface);' +
    'border:1px solid var(--border-strong);border-radius:8px;padding:6px 9px;';

  const btn = document.createElement('button');
  btn.textContent = '创建';
  btn.style.cssText =
    'align-self:flex-start;border:1px solid var(--accent);background:var(--accent);' +
    'color:#fff;border-radius:8px;padding:5px 11px;cursor:pointer;font:inherit;font-size:12.5px;';
  btn.onclick = () => {
    const id = input.value.trim();
    if (!id) return host.fail('先填连接 id');
    // 真实渠道在这里调自己的 HTTP 端点落数据（`POST /api/p/channel-mock/connections`）。
    host.done();
  };

  wrap.append(hint, input, btn);
  root.append(wrap);
  return () => {
    root.textContent = '';
  };
}
