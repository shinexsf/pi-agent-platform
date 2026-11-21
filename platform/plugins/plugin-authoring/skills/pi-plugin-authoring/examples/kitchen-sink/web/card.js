/**
 * web/card.js — 工具卡片接管（mode: 'replace'）。
 *
 * 宿主额外提供 host.toolCard：
 *   host.toolCard.call         当前工具调用快照（冻结的普通 JSON）
 *   host.toolCard.subscribe(fn) 订阅该调用更新（流式期间会多次回调），返回取消函数
 *   host.toolCard.shell()      平台原生卡片外壳（可选使用）
 *
 * 约束：只渲染自己的 el；不要改全局样式、不要 teleport 出去。
 */

export function mount(el, host) {
  const card = host.toolCard;
  if (!card) {
    // 非卡片挂载点下 toolCard 为 undefined —— 兜底而不是报错
    el.textContent = '（此处不是工具卡片上下文）';
    return () => {};
  }

  const render = (call) => {
    el.innerHTML = `
      <div style="padding:12px 16px;line-height:1.6">
        <div><strong>${call.name}</strong> ${call.streaming ? '（流式中…）' : `· ${call.durationMs ?? 0}ms`}</div>
        <pre style="margin:8px 0 0;white-space:pre-wrap">${JSON.stringify(call.args, null, 2)}</pre>
        ${call.error ? `<div style="color:var(--err)">${call.error}</div>` : ''}
      </div>`;
  };

  render(card.call);
  const off = card.subscribe(render);

  return () => off();
}
