/**
 * 架构图清单 —— 按「集合」分组（`/architecture` 页的两级切换器）。
 *
 * 为什么要分集合：**本平台的架构**和**原生 pi 的模块**是两套互不隶属的知识。
 * 混在一个 tab 行里会有两个问题：一是「插件系统」这种同名概念在两边含义不同，
 * 二是两侧都在持续加图，串在一起迟早要横向滚动到看不清。所以集合是硬边界：
 * 不同的集合、不同的目录、不同的默认图，只在同一个页面里共用切换器与 iframe 宿主。
 *
 * 每张图 = 一份手写 spec（`apps/pi-agent-web/architecture/<file>.json`）+ archify 编译产物
 * （`public/architecture/<file>.html`，自包含单文件）。spec 是唯一事实源，改图流程
 * （以集合 `pi` 为例，产物放 `public/architecture/pi/`）：
 *
 *   archify finalize <type> architecture/pi/<name>.<type>.json \
 *     public/architecture/pi/<name>.<type>.html --repo-root <仓库根> --quality showcase
 *
 * 平台相关的图带 `sources`（仓库相对路径 + 行号），编译时校验来源存在于
 * `meta.repository.revision` 指向的提交；pi 原生图没有本仓库来源可引，靠标题里的版本号自证。
 *
 * URL：`/architecture?set=<collectionId>&d=<slug>`。只给 `d` 的老链接仍然能打开（按 slug 反查集合），
 * `slug` 因此必须全局唯一。
 */
export type ArchitectureDiagramType =
  | 'architecture'
  | 'sequence'
  | 'workflow'
  | 'dataflow'
  | 'lifecycle'
  | 'erd'
  | 'tree'
  | 'class'
  | 'timeline'
  | 'waterfall';

export interface ArchitectureDiagram {
  slug: string;
  /** 切换器上的短标签（≤6 字为宜，紧凑断点会横向滚动） */
  label: string;
  /** 这张图回答什么问题，显示在切换器右侧 */
  hint: string;
  type: ArchitectureDiagramType;
  /** public/architecture 下的相对路径（集合 pi 用 `pi/` 子目录） */
  file: string;
}

export interface ArchitectureCollection {
  /** URL 参数 `?set=` */
  id: string;
  /** 集合选择器上的标签 */
  label: string;
  /** 集合没有选中图时显示在右侧的说明 */
  hint: string;
  /** 集合为空时的占位文案 */
  emptyHint: string;
  diagrams: readonly ArchitectureDiagram[];
}

/** 平台相关的图（有仓库证据）。第一项是默认图。 */
const PLATFORM_DIAGRAMS: readonly ArchitectureDiagram[] = [
  {
    slug: 'platform',
    label: '总览架构',
    hint: '平台由哪些进程、边界和存储组成，谁调谁',
    type: 'architecture',
    file: 'pi-agent-platform.architecture.html',
  },
  {
    slug: 'session-prompt',
    label: '核心流程时序',
    hint: '一次 prompt 从 HTTP 进入到 SSE 回流的完整往返（含反向调用）',
    type: 'sequence',
    file: 'session-prompt.sequence.html',
  },
  {
    slug: 'plugins',
    label: '插件系统',
    hint: '四类 facet 跑在哪、两层闸门怎么拦、界面贡献怎么到浏览器',
    type: 'architecture',
    file: 'plugin-system.architecture.html',
  },
  {
    slug: 'plugin-map',
    label: '插件扩展点',
    hint: '每个叶子都是今天真实存在的挂载点，单点处就是将来的扩展位',
    type: 'tree',
    file: 'plugin-map.tree.html',
  },
];

/**
 * 原生 pi 的模块图。
 *
 * 证据形态与平台图不同：pi 装在 node_modules 里（gitignored），没有仓库 sources 可引，
 * 所以版本钉在标题（pi 1.3.0）、结论写在卡片里，调研结果回流私域 pi 知识库（`.pi/` 仓库，不进本仓库）。
 * 加图 = 往 `diagrams` 里加一项，spec 放 `architecture/pi/`、产物放 `public/architecture/pi/`。
 */
const PI_DIAGRAMS: readonly ArchitectureDiagram[] = [
  {
    slug: 'pi-lifecycle',
    label: '生命周期',
    hint: '一次 run 从输入到 agent_settled；session_start 只在换会话时发',
    type: 'lifecycle',
    file: 'pi/pi-lifecycle.lifecycle.html',
  },
  {
    slug: 'pi-events',
    label: '事件流',
    hint: '一条消息按顺序发出哪些事件、谁在听、什么时候落盘',
    type: 'sequence',
    file: 'pi/pi-events.sequence.html',
  },
  {
    slug: 'pi-extension-points',
    label: '扩展点',
    hint: 'ExtensionAPI 的全部面：41 个 hook + 注册口 + ctx',
    type: 'tree',
    file: 'pi/pi-extension-points.tree.html',
  },
  {
    slug: 'pi-session-file',
    label: '历史文件',
    hint: 'session.jsonl 的 12 种 entry、id/parentId 树与上下文重建',
    type: 'tree',
    file: 'pi/pi-session-file.tree.html',
  },
];

export const ARCHITECTURE_COLLECTIONS: readonly ArchitectureCollection[] = [
  {
    id: 'platform',
    label: '本平台',
    hint: 'pi-agent-platform 自己的架构：进程、会话、插件、能力面',
    emptyHint: '这个集合还没有图',
    diagrams: PLATFORM_DIAGRAMS,
  },
  {
    id: 'pi',
    label: '原生 pi',
    hint: '上游 pi（@earendil-works/pi-coding-agent）自身的模块与契约，不隶属本平台',
    emptyHint: 'pi 原生模块图还没画',
    diagrams: PI_DIAGRAMS,
  },
];

/** 无 `?set=` 参数时的默认集合。 */
export const DEFAULT_COLLECTION_ID = 'platform';

export function findCollection(id: unknown): ArchitectureCollection {
  const wanted = typeof id === 'string' ? id : '';
  const found = ARCHITECTURE_COLLECTIONS.find((c) => c.id === wanted);
  if (found) return found;
  // 兜底用 id 查找而不是 `[0]`：noUncheckedIndexedAccess 下下标访问的类型是 `T | undefined`。
  return ARCHITECTURE_COLLECTIONS.find((c) => c.id === DEFAULT_COLLECTION_ID) ?? ARCHITECTURE_COLLECTIONS[0]!;
}

/** 按 slug 反查集合（兼容只有 `?d=` 的老链接）。 */
export function findDiagram(slug: unknown): { collection: ArchitectureCollection; diagram: ArchitectureDiagram } | null {
  const wanted = typeof slug === 'string' ? slug : '';
  if (!wanted) return null;
  for (const collection of ARCHITECTURE_COLLECTIONS) {
    const diagram = collection.diagrams.find((d) => d.slug === wanted);
    if (diagram) return { collection, diagram };
  }
  return null;
}

/**
 * 解析出「当前集合 + 当前图」。
 * - `d` 命中某张图 → 用那张图的集合（老链接只有 d）
 * - 否则用 `set`（缺省 platform），图取该集合第一张
 * - 集合为空 → diagram 为 null（页面显示占位）
 */
export function resolveArchitectureView(
  setParam: unknown,
  diagramParam: unknown,
): { collection: ArchitectureCollection; diagram: ArchitectureDiagram | null } {
  const hit = findDiagram(diagramParam);
  if (hit) return hit;
  const collection = findCollection(setParam);
  return { collection, diagram: collection.diagrams[0] ?? null };
}
