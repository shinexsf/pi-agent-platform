/**
 * web/panel.js — 会话页右侧槽位（chat.rail.right）的抽屉面板。
 *
 * 这里拿到的是「会话上下文」：host.sessionId 有值，host.data.emit 可上行到 worker。
 * 关闭顺序由宿主保证：停推数据 → dispose() → 移除 el。
 */

export function mount(el, host) {
  el.innerHTML = `
    <div style="padding:16px;line-height:1.7">
      <strong>会话：</strong><code>${host.sessionId || '(全局)'}</code>
      <div style="margin-top:12px">
        <button id="ping">向 worker 发一条事件</button>
      </div>
      <ul id="log" style="margin-top:12px;padding-left:18px"></ul>
    </div>`;

  const log = el.querySelector('#log');
  const push = (text) => {
    const li = document.createElement('li');
    li.textContent = text;
    log.appendChild(li);
  };

  // worker → 浏览器（worker facet 的 bridge.emit 会到这里）
  const off = host.data.subscribe(({ name, data }) => {
    push(`↓ ${name}: ${JSON.stringify(data)}`);
  });

  // 浏览器 → worker（worker facet 的 bridge.onEmit 会收到）
  const btn = el.querySelector('#ping');
  const onClick = () => host.data.emit('ping', { at: Date.now() });
  btn.addEventListener('click', onClick);

  return () => {
    off();
    btn.removeEventListener('click', onClick);
  };
}
