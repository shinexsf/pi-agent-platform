/**
 * 打包清单 —— 单一来源，供 build-cli.mjs（复制）与 check-packaged.mjs（校验）共用。
 *
 * 为什么需要：这些 @pi-agent-platform/* 是私有 workspace 包，不在 npm registry 上；
 * 而 tsc 产物会把裸包名原样保留，所以必须手动把它们的产物复制进 tarball 的
 * node_modules/@pi-agent-platform/<name>/，否则安装后 ERR_MODULE_NOT_FOUND。
 *
 * 新增包时：只要被运行时 import，就必须加进这里（两个脚本自动同步）。
 *
 * `plugin-types` **刻意不在这里**：它是 types-only 包（dist 只有 `.d.ts`，没有 `.js`），
 * 运行期谁都不 import 它；第三方插件的类型以 vendored `.d.ts` 交付。
 * 一旦有代码在运行期 import 它，check-packaged 会因为"产物内解析失败"报错 —— 这正是想要的。
 */
export const RUNTIME_PACKAGES = [
  'shared-types',
  'channel-types',
  'api-types',
  'ipc-protocol',
  'sdk-integration',
  'event-projection',
  'core',
];
