/**
 * web facet —— 在浏览器（SPA 内）执行。
 *
 * 入口：命名导出 mount(el, host)，必须返回 dispose 函数。
 * 只允许动自己的 el：不要写全局样式、不要 teleport、不要碰路由。
 */

export async function mount(el, host) {
  el.textContent = '加载中…';

  try {
    // host.api 只会打到本插件自己的前缀 /api/p/<pluginId>/
    const who = await host.api.get('/whoami');
    el.innerHTML = `
      <div style="padding:16px;line-height:1.7">
        <strong>插件：</strong>${host.pluginId}<br />
        <strong>端点返回：</strong><code>${JSON.stringify(who)}</code>
      </div>`;
    host.ui.toast('hello-plugin 已加载', 'success');
  } catch (err) {
    // 页面级失败只影响自己，不要把异常抛给宿主
    el.textContent = `调用 /whoami 失败：${err && err.message ? err.message : String(err)}`;
  }

  // 关闭/切页时由宿主调用：停订阅 → 清理 DOM
  return () => {
    el.textContent = '';
  };
}
