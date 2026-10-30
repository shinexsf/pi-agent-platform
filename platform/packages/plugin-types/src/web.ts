/**
 * web facet 契约（骨架）。
 *
 * 单独一个入口是为了把 DOM 类型隔离在浏览器侧：server / worker 的 tsconfig
 * 不引 DOM lib，它们只 import 包根（`@pi-agent-platform/plugin-types`）。
 *
 * 边界不变量：宿主与插件之间只交换
 * - 普通 JSON（不可变、非响应式）
 * - 回调
 * - DOM 节点（只有 `el` 这一个交接点）
 */

/** 浏览器侧宿主能力（骨架）。 */
export interface PluginWebHost {
  readonly pluginId: string;
  /** 只读会话标识。 */
  readonly sessionId: string;
  /** 订阅插件事件。载荷是冻结的普通 JSON，不是响应式对象。 */
  data: {
    subscribe(fn: (payload: unknown) => void): () => void;
  };
  /** 调用本插件自己前缀下的 REST（相对 `/api/<pluginId>/`）。 */
  api: {
    post(path: string, body?: unknown): Promise<unknown>;
  };
  /** 主题：只保证约定的 CSS 变量存在于 `el` 的祖先链上。 */
  theme: {
    get(): 'light' | 'dark';
    subscribe(fn: (theme: 'light' | 'dark') => void): () => void;
  };
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

/**
 * web facet 挂载入口。
 *
 * - 所有 DOM 节点必须落在 `el` 之内（不得 teleport 到外部）
 * - 不得写全局 CSS 选择器
 * - 返回的清理函数在槽位关闭时被调用（宿主先停止推数据，再调用它，最后移除 `el`）
 */
export type PluginWebMount = (el: HTMLElement, host: PluginWebHost) => void | (() => void);
