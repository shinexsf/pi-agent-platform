/**
 * R11 顶栏动作的面板内容（点顶栏图标就地展开，不跳页）。
 * 与其它挂载点同一契约：`mount(el, host)`，返回清理函数。
 */
export function mount(el, host) {
  const p = document.createElement('div');
  p.style.cssText = 'font-size:13px;line-height:1.6';
  p.innerHTML = '<strong>顶栏动作示例</strong><br/>这个面板由 <code>host.ui.headerAction()</code> 注册，点顶栏图标打开。';
  el.replaceChildren(p);
  return () => el.replaceChildren();
}
