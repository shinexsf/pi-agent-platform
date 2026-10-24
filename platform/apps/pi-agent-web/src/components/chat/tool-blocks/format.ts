/**
 * Formatting helpers shared by tool blocks. Moved out of MessageItem so blocks
 * (and future user-script-provided blocks) use identical formatting.
 */

/** Collapse strings longer than this into a single-line preview row. */
export const ARG_LONG_THRESHOLD = 200

/** Stringify an arg value uniformly. Strings pass through (newlines preserved);
 *  objects/arrays/numbers/booleans become single-line JSON. */
export function formatArgValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function isMultiLine(s: string): boolean {
  return /\r?\n/.test(s)
}

export function isLong(s: string): boolean {
  return s.length > ARG_LONG_THRESHOLD
}

export interface FormattedArg {
  key: string
  value: string
  isFile: boolean
  isMultiLine: boolean
  isLong: boolean
}

export function formatArgs(args: Record<string, unknown>): FormattedArg[] {
  return Object.entries(args).map(([key, value]) => {
    const str = formatArgValue(value)
    return {
      key,
      value: str,
      // File-link affordance only for single-line path strings. A multi-line
      // string named `path` is almost certainly content, not a filesystem path.
      isFile: key === 'path' && typeof value === 'string' && !isMultiLine(str),
      isMultiLine: isMultiLine(str),
      isLong: !isMultiLine(str) && isLong(str),
    }
  })
}

/**
 * Flatten newlines into a literal `\n` (2 chars) so multi-line tool output still
 * fits on one preview row alongside ellipsis. The expanded block renders the
 * original text, preserving real newlines.
 */
export function flattenForPreview(s: string): string {
  return s.replace(/\r?\n/g, '\\n')
}

/** Return the first non-empty line of a multi-line string (collapsed preview). */
export function firstNonEmptyLine(s: string): string {
  const lines = s.replace(/^\s+|\s+$/g, '').split('\n')
  for (const line of lines) {
    if (line.trim().length > 0) return line
  }
  return ''
}

/** Read an argument as a string (`undefined` → `''`), stringifying non-strings. */
export function argString(args: Record<string, unknown> | undefined, key: string): string {
  const value = args?.[key]
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : formatArgValue(value)
}

/** Number of lines in a string (`''` counts as 0). */
export function countLines(s: string): number {
  return s ? s.split('\n').length : 0
}

export interface ToolStatus {
  label: string
  /** CSS class fragment: `status-running` / `status-completed` / `status-error`. */
  cls: string
}

export function toolStatus(call: { result?: string; isError?: boolean }): ToolStatus {
  if (call.isError) return { label: '[failed]', cls: 'status-error' }
  if (call.result === undefined) return { label: '[running]', cls: 'status-running' }
  return { label: '[completed]', cls: 'status-completed' }
}

/** Inline SVG icon per known tool (unknown tools get a neutral dot). */
export function toolIcon(name: string): string {
  switch (name) {
    case 'read':
      return '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 2h7l3 3v9H3V2z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M10 2v3h3" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5 8h6M5 10h4" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>'
    case 'write':
      return '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 2h7l3 3v9H3V2z" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M10 2v3h3" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 9l2 2 3-4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    case 'edit':
      return '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'
    case 'bash':
      return '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 12h4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
    default:
      return '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 6v4M6 8h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>'
  }
}

// ---------- Tool name → card bindings live in `registry.ts` ----------
// Dispatch is by tool NAME, not by a semantic "kind": only first-party tools
// have a knowable category, and a future user script also matches by name.
