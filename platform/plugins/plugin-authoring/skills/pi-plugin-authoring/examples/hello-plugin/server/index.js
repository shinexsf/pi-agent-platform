/**
 * server facet —— 在主进程里执行。
 *
 * 唯一入口：`export default { init(host) }`（纯对象；顶层零副作用）。
 * 所有注册都必须发生在 `init()` 里（路由表首次请求后冻结）。
 * 这个文件演示最小集：一个配置二级菜单项 + 一个页面 + 一个 GET 端点。
 */

export default {
  init(host) {
  // 1) 菜单：parent: 'config' 挂到「配置」二级；order 小者靠前
  host.global.menus.register({
    id: 'hello',
    label: '示例（Hello）',
    icon: 'layers',
    parent: 'config',
    order: 1200,
    page: 'hello', // 指向下面 pages 注册的 id
  });

  // 2) 页面：entry 对应 web/<entry>.js，即 web/page.js 的 mount()
  host.global.pages.register({ id: 'hello', entry: 'page' });

  // 3) HTTP 端点：挂在 /api/p/<pluginId>/ 下，路径精确匹配（不支持通配符）
  //    handler 收到 PluginRouteRequest，返回 { json } / { body } / { status, headers }
  host.global.routes.register({
    method: 'GET',
    path: '/whoami',
    handler: (req) => ({
      json: { pluginId: host.id, method: req.method, path: req.path, query: req.query },
    }),
  });

  // 4) 日志进平台日志（自动带 pluginId）
  host.log('info', 'hello-plugin registered');
  },
};
