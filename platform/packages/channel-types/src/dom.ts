/**
 * DOM-target (frontend) channel interfaces.
 *
 * Direction of calls:
 *   Host → Package: ChannelAdminPage (host renders it)
 *   Package → Host: ChannelAdminHost (package calls host to fetch API, show toast, etc.)
 *
 * Separate export entry to avoid bundling DOM code on the server side.
 */

import type { ChannelType } from './common.js';

export type { ChannelType };

/** Toast payload. */
export interface ToastOptions {
  message: string;
  variant?: 'info' | 'success' | 'warning' | 'error';
  durationMs?: number;
}

/** Confirm dialog options. */
export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// ChannelAdminPage — host renders this
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Admin page exported by a channel package.
 * Web host dynamically imports via `import.meta.glob` and renders these.
 */
export interface ChannelAdminPage {
  readonly channelType: ChannelType;
  readonly displayName: string;
  /** Main component (default page). */
  readonly component: () => Promise<{ default: unknown }>;
}

// ──────────────────────────────────────────────────────────────────────────────
// ChannelAdminHost — package pages call this
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Host facade exposed to admin pages via `useChannelAdminHost()` composable.
 * Lets admin pages call the right API prefix and access global UI primitives.
 */
export interface ChannelAdminHost {
  /**
   * Fetch JSON from the server.
   * `path` is relative to the channel's API prefix, e.g. `apiFetch("GET", "/channels")`
   * resolves to `/api/im/<channelType>/channels`.
   */
  apiFetch(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown>;

  /** Show a global toast. */
  showToast(options: ToastOptions): void;

  /** Show a global confirm dialog. Returns user's choice. */
  showConfirmDialog(options: ConfirmDialogOptions): Promise<boolean>;

  /** Lightweight i18n helper (returns key if translation missing). */
  useI18n(): { t: (key: string, params?: Record<string, unknown>) => string };
}