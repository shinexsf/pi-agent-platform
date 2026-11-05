/**
 * web facet 契约。
 *
 * 单独一个入口是为了把 DOM 类型隔离在浏览器侧：server / worker 的 tsconfig
 * 不引 DOM lib，它们只 import 包根（`@pi-agent-platform/plugin-types`）。
 *
 * 边界不变量：宿主与插件之间只交换
 * - 普通 JSON（不可变、非响应式）
 * - 回调
 * - DOM 节点（只有 `el` 这一个交接点）
 */

/** 工具调用快照（冻结的普通 JSON，不是响应式对象）。 */
export interface ToolCallSnapshot {
  /** 工具名（如 `sendFileToUser`、`mcp__rea__list_architectures`）。 */
  name: string;
  /** 参数（原始 JSON）。 */
  args: unknown;
  /** 结果文本（累积后的完整内容）；流式期间为已到达的部分。 */
  result?: string;
  /** 错误信息（工具失败时）。 */
  error?: string;
  /** 工具产出的图片（data URI）。 */
  images?: string[];
  /** 是否仍在流式。 */
  streaming: boolean;
  /** 总耗时（ms）；未结束时为已耗时。 */
  durationMs?: number;
  /** 条目 id，可用作订阅键。 */
  entryId?: string;
}

/** 工具卡片宿主提供的额外能力（`mode: 'replace'` 时才有意义）。 */
export interface ToolCardHostExtras {
  /** 当前工具调用快照（冻结）。 */
  call: ToolCallSnapshot;
  /** 订阅该工具调用的更新；返回取消函数。 */
  subscribe(fn: (snapshot: ToolCallSnapshot) => void): () => void;
  /** 平台原生的卡片外壳（头部 + 折叠行为）；插件可选择用它包住自己的内容。 */
  shell(): {
    /** 把内容渲染到卡片体内，返回清理函数。 */
    body(render: (el: HTMLElement) => void): void;
    /** 当前是否展开。 */
    expanded(): boolean;
    /** 订阅展开态变化。 */
    onToggle(fn: (expanded: boolean) => void): () => void;
  };
}

/** 浏览器侧宿主能力。 */
export interface PluginWebHost {
  readonly pluginId: string;
  /** 只读会话标识；全局页面（如配置页插件）为空串。 */
  readonly sessionId: string;
  /** 插件事件通道（worker → server → SSE）。载荷是冻结的普通 JSON。 */
  data: {
    /** 订阅本插件的事件；回调收到 `{ name, data }`。 */
    subscribe(fn: (frame: { name: string; data: unknown }) => void): () => void;
    /** 浏览器 → worker 的上行事件（会话上下文才可用；全局页面下为空操作）。 */
    emit(name: string, data?: unknown): void;
  };
  /** 调用本插件自己前缀下的 REST（相对 `/api/p/<pluginId>/`）。 */
  api: {
    get(path: string): Promise<unknown>;
    post(path: string, body?: unknown): Promise<unknown>;
    put(path: string, body?: unknown): Promise<unknown>;
    del(path: string): Promise<unknown>;
    /** 取二进制（图片、下载文件）。路径前缀同样是 `/api/p/<pluginId>/`。 */
    blob(path: string): Promise<Blob>;
  };
  /** 宿主 UI 能力。 */
  ui: {
    /** 底部抽屉（移动端友好）。 */
    sheet(options: { title?: string; render: (el: HTMLElement) => void | (() => void) }): () => void;
    /** 轻提示。 */
    toast(message: string, kind?: 'info' | 'success' | 'error'): void;
  };
  /** 工具卡片专属能力；非卡片挂载点下为 `undefined`。 */
  toolCard?: ToolCardHostExtras;
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
