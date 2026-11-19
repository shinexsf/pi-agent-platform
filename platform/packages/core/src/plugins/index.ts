/**
 * 插件体系的运行期入口（`@pi-agent-platform/core/plugins`）。
 *
 * 契约（类型）在 `@pi-agent-platform/plugin-types`；这里放**判定依据与磁盘操作**：
 * 常量（契约版本 / facet 名单 / 槽位白名单）与 registry 读写。
 * 拆开的原因：契约包必须 types-only，见 `plugin-types/src/index.ts` 头部。
 */

export * from './constants.js';
export * from './registry.js';
export * from './check.js';
