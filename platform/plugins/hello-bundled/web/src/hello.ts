/**
 * bundled 插件的 web facet 源码（TS）—— 由 `pnpm build:plugins` 编译成同目录 `hello.js`。
 *
 * 第三方插件没有这一步：作者自己编译后发布 `.js`（平台不替第三方编译）。
 */
export function mount(el: HTMLElement, host: { pluginId: string }): () => void {
  const h = document.createElement('h2');
  h.textContent = `Hello from bundled plugin (${host.pluginId})`;
  const p = document.createElement('p');
  p.dataset.bundled = 'ok';
  p.textContent = '这个页面由随包插件的 web facet 提供，产物由 build:plugins 编译。';
  el.append(h, p);
  return () => {
    el.replaceChildren();
  };
}
