/**
 * 给插件用的站内跳转入口。
 *
 * 为什么单独一个文件：`plugins/host.ts` 不能直接 import router 实例（`main.ts` 才创建它，
 * 直接引会形成模块环）。这里持有 `main.ts` 注册进来的 navigator，插件侧只看到
 * `host.ui.navigate(path)` 一个动作 —— 不暴露 router 对象（暴露了插件就能改路由表）。
 */

let navigator: ((path: string) => void) | null = null;

/** 由 `main.ts` 在创建 router 后调用一次。 */
export function installNavigator(fn: (path: string) => void): void {
  navigator = fn;
}

export function navigate(path: string): void {
  if (navigator) {
    navigator(path);
    return;
  }
  // 兜底：navigator 还没装（极早期），退回整页跳转
  window.location.assign(path);
}
