// 随包插件示例：不登记 registry，目录存在即装载。
export default {
  init(host) {
    host.http.route({
      method: 'GET',
      path: '/hello',
      handler: () => ({ json: { from: 'hello-bundled', bundled: true } }),
    });
    // R1：页面 + 菜单一次注册（web 产物由 build:plugins 编译）
    host.ui.page({ path: '/hello', label: 'Hello', icon: 'sparkles', component: 'hello', order: 950 });
    host.log('info', 'hello-bundled loaded (bundled)');
  },
};
