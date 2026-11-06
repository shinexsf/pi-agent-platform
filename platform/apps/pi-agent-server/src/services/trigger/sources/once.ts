/**
 * `once` source — fire once at an absolute instant, then stop.
 *
 * Stopping uses the generic `max_runs = 1` field (no per-source hook):
 * `dispatch` disables the trigger when `runs_count >= max_runs`.
 */

import type { SourceSpec } from '../sources.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const onceSource: SourceSpec = {
  source: 'once',
  label: '一次性',
  description: '在指定时刻触发一次，之后自动停用',
  defaultMaxRuns: 1,
  validateConfig(config) {
    const raw = config.at;
    let at: number;
    if (typeof raw === 'number') at = raw;
    else if (typeof raw === 'string') at = Date.parse(raw);
    else throw new Error('once: 缺少触发时刻 at');
    if (!Number.isFinite(at)) throw new Error('once: at 不是合法时间');
    // 30s grace so a "now + 5s" test trigger isn't rejected by clock skew.
    if (at < Date.now() - 30_000) throw new Error('once: at 必须是将来的时间');
    return { at };
  },
  computeNextAt(config, from) {
    const at = typeof config.at === 'number' ? config.at : Date.parse(String(config.at ?? ''));
    if (!Number.isFinite(at) || at <= from) return null;
    return at;
  },
  housekeeping({ deleteStaleDisabled }) {
    deleteStaleDisabled('once', Date.now() - THIRTY_DAYS_MS);
  },
};
