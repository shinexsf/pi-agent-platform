/**
 * 配置模块的 section 定义 —— 单一事实来源。
 *
 * 消费方：
 *   - `components/layout/nav-tree.ts`（抽屉二级菜单）
 *   - `views/config/ConfigView.vue`（紧凑断点的顶部分段控件）
 *
 * 注意：section 的 id 同时是路由参数值（`/config/:section`）。
 */

export interface ConfigSectionMeta {
  id: string;
  label: string;
  icon: string;
}

export const CONFIG_SECTIONS: readonly ConfigSectionMeta[] = [
  { id: 'models', label: '模型 API', icon: '🔧' },
  { id: 'settings', label: '默认设置', icon: '⚙️' },
  { id: 'skills', label: 'Skills', icon: '📚' },
  { id: 'prompts', label: 'Prompts', icon: '💬' },
  { id: 'extensions', label: '插件管理', icon: '🧩' },
  { id: 'logs', label: '系统日志', icon: '📜' },
] as const;

export const DEFAULT_CONFIG_SECTION = CONFIG_SECTIONS[0]!.id;

/** 把任意路由参数值收敛到合法的 section id（非法值 fallback 到默认）。 */
export function resolveConfigSection(raw: unknown): string {
  const id = typeof raw === 'string' ? raw : '';
  return CONFIG_SECTIONS.some((section) => section.id === id)
    ? id
    : DEFAULT_CONFIG_SECTION;
}

export function configSectionLabel(id: string): string {
  return CONFIG_SECTIONS.find((section) => section.id === id)?.label ?? id;
}

/**
 * 从路由 path 解析当前 section：`/config/skills/my-skill` → `skills`。
 * 嵌套路由下 section 不再是一个命名参数，而是路径的第二段。
 */
export function configSectionFromPath(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return resolveConfigSection(segments[1]);
}
