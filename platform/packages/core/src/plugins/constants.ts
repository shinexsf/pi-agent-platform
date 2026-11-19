/**
 * 插件运行期常量 —— 曾经的 `plugin-types` 运行期导出，现在归内核。
 *
 * 为什么搬到这里：`plugin-types` 是 **types-only** 包（只出 `.d.ts`），
 * 一旦它带运行期导出，作者产物里就会留下 `import '@pi-agent-platform/plugin-types'`
 * 这种裸说明符 —— 浏览器解析不了，Node 侧又会去加载 TS 源码。
 *
 * 这些常量是**平台的判定依据**（装载器/CLI 用），不该由插件 import；
 * 插件在声明里自己写 `apiVersion: '1'`，装载器读到后与 `PLUGIN_API_VERSION` 比对。
 */

/** 当前平台契约版本。插件在自己的默认导出里声明 `apiVersion`。 */
export const PLUGIN_API_VERSION = '1' as const;

/** facet 名 = 目录名。目录存在即声明该 facet。 */
export const PLUGIN_FACET_NAMES = ['server', 'worker', 'extension', 'web'] as const;

/**
 * 插件可以挂载的 UI 槽位。
 *
 * 一个槽位 = **一个完整的界面入口**：`chat.rail.right` 是会话页右侧 icon 轨道上的
 * 一个按钮及其抽屉面板。槽位名由平台硬编码 —— 插件不能新造槽位，加槽位要改 UI 并发版。
 */
export const PLUGIN_SLOT_NAMES = ['chat.rail.right'] as const;

/**
 * facet 在当前平台的装载支持度。
 *
 * - `loaded`        平台会真的执行它
 * - `declared-only` 只有契约与目录探测，没有装载实现
 *
 * 目录页"扩展点是否可用"的唯一依据：不允许用"目录存在"冒充"可用"。
 */
export const FACET_SUPPORT = {
  server: 'loaded',
  worker: 'loaded',
  extension: 'loaded',
  web: 'loaded',
} as const;
