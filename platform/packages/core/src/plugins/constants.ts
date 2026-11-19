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

/**
 * 平台**承诺**给插件 web 面的 CSS 变量清单（`apps/pi-agent-web/src/style.css` 的
 * `:root` / `html[data-theme="dark"]`）。
 *
 * 为什么要有这份清单：插件 UI 在暗色下翻车只有一种原因 —— 猜了个不存在的变量名，
 * 于是 `var(--x, #fff)` 的 fallback 生效、白底写死在暗色里。真实案例：scheduler 插件的
 * 第一版用了 `--bg-elevated` / `--text-muted` / `--bg-hover`，三个都不存在。
 *
 * 所以"约定"必须是**可枚举、可校验**的：`plugin check` 会扫插件 web 产物的
 * `var(--name)`，不在清单里的给 warning。加新变量要同时改 style.css 与这份清单。
 */
export const PLATFORM_THEME_VARS = [
  // 背景 / 表面
  '--bg', '--surface', '--surface-raised', '--surface-subtle', '--surface-hover',
  // 文字
  '--text', '--text-secondary', '--text-tertiary',
  // 描边
  '--border', '--border-subtle', '--border-strong',
  // 主色
  '--accent', '--accent-hover', '--accent-ink', '--accent-soft',
  // 语义色
  '--success', '--success-soft', '--warning', '--warning-soft',
  '--danger', '--danger-hover', '--danger-soft', '--on-error',
  // 其它
  '--focus', '--shadow-soft', '--shadow-raised',
  '--radius-sm', '--radius-md', '--radius-lg',
  '--font-sans', '--font-mono',
  '--code-bg', '--code-inline-bg', '--code-border',
  '--hl-key', '--hl-string', '--hl-number', '--hl-comment', '--hl-builtin', '--hl-attr', '--hl-meta',
  '--app-header-h',
] as const;
