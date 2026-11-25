/**
 * 全局提示 / 确认的载荷形状。
 *
 * 这两个类型以前住在 `@pi-agent-platform/channel-types`（渠道 admin 契约包里）——
 * 但提示与确认是**平台级的 UI 能力**，跟渠道没关系。渠道下沉成插件后这两个类型
 * 就地留下，渠道包与 `channel-types` 一起退役。
 */

export interface ToastOptions {
  message: string;
  variant?: 'info' | 'success' | 'warning' | 'error';
  durationMs?: number;
}

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}
