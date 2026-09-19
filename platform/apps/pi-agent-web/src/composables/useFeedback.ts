/**
 * useFeedback — 全局提示 / 确认的统一入口。
 *
 * 复用 `AppShell` 已挂载的 `ToastHost` / `ConfirmDialogHost`（事件驱动契约见
 * `modules/im-gateway/components/*Host.vue`），不新增第二套提示基础设施，
 * 并彻底替代 `window.alert` / `window.confirm`（spec route-based-modals）。
 */
import type { ConfirmDialogOptions, ToastOptions } from '@pi-agent-platform/channel-types';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ConfirmInput {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}

/** 显示一条 toast。第二参可直接给 variant（`toast('保存成功', 'success')`）。 */
export function toast(input: string | ToastOptions, variant?: ToastVariant): void {
  const detail: ToastOptions =
    typeof input === 'string'
      ? variant
        ? { message: input, variant }
        : { message: input }
      : input;
  window.dispatchEvent(new CustomEvent('im-gateway:toast', { detail }));
}

/** 显示确认弹框，返回用户选择。 */
export function confirmDialog(input: ConfirmInput): Promise<boolean> {
  return new Promise((resolve) => {
    const w = window as unknown as { __imConfirmResolver?: (value: boolean) => void };
    w.__imConfirmResolver = resolve;
    const detail: ConfirmDialogOptions = {
      message: '',
      confirmText: '确定',
      cancelText: '取消',
      ...input,
    };
    window.dispatchEvent(new CustomEvent('im-gateway:confirm', { detail }));
  });
}

/** 删除类操作的标准确认文案。 */
export function confirmDelete(entityLabel: string, name: string): Promise<boolean> {
  return confirmDialog({
    title: `删除 ${entityLabel}`,
    message: `确定要删除「${name}」吗？此操作不可撤销。`,
    confirmText: '删除',
    destructive: true,
  });
}

export function useFeedback() {
  return { toast, confirm: confirmDialog, confirmDelete };
}
