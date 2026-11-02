/**
 * 打包清单 —— 单一来源，供 build-cli.mjs（复制）与 check-packaged.mjs（校验）共用。
 *
 * 为什么需要：这些 @pi-agent-platform/* 是私有 workspace 包，不在 npm registry 上；
 * 而 tsc 产物会把裸包名原样保留，所以必须手动把它们的产物复制进 tarball 的
 * node_modules/@pi-agent-platform/<name>/，否则安装后 ERR_MODULE_NOT_FOUND。
 *
 * 新增包时：只要被运行时 import，就必须加进这里（两个脚本自动同步）。
 */
export const RUNTIME_PACKAGES = [
  'shared-types',
  'channel-types',
  'api-types',
  'ipc-protocol',
  'sdk-integration',
  'plugin-types',
];
