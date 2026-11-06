/**
 * `cron` source — five-field expression + IANA timezone.
 *
 * Uses its own dependency-free implementation (services/trigger/cron.ts).
 * Minimum interval is enforced at creation time (platform guard, 5 minutes).
 */

import type { SourceSpec } from '../sources.js';
import { MIN_CRON_INTERVAL_MINUTES, isValidTimeZone, nextCronTime, parseCronExpr } from '../cron.js';

const DEFAULT_TZ = 'Asia/Shanghai';

export const cronSource: SourceSpec = {
  source: 'cron',
  label: '定时',
  description: 'cron 表达式（5 段），按指定时区触发；最小间隔 5 分钟',
  validateConfig(config) {
    const expr = typeof config.expr === 'string' ? config.expr.trim() : '';
    if (!expr) throw new Error('cron: 缺少表达式 expr');
    // Throws with a specific message on bad syntax / unsatisfiable expressions.
    const fields = parseCronExpr(expr);
    const tz = typeof config.tz === 'string' && config.tz.trim() ? config.tz.trim() : DEFAULT_TZ;
    if (!isValidTimeZone(tz)) throw new Error(`cron: 未知时区 ${tz}`);

    const now = Date.now();
    const first = nextCronTime(expr, tz, now);
    if (first === null) throw new Error('cron: 表达式在可预见时间内不会触发');
    const second = nextCronTime(expr, tz, first);
    if (second !== null) {
      const gapMinutes = (second - first) / 60_000;
      // `* * * * *`-style expressions fall foul here; day-granularity ones pass.
      const anyEveryMinute = fields.minutes.size > 1 && fields.hours.size === 24;
      if (anyEveryMinute && gapMinutes < MIN_CRON_INTERVAL_MINUTES) {
        throw new Error(`cron: 间隔不能小于 ${MIN_CRON_INTERVAL_MINUTES} 分钟`);
      }
    }
    return { expr, tz };
  },
  computeNextAt(config, from) {
    const expr = String(config.expr ?? '');
    const tz = String(config.tz ?? DEFAULT_TZ);
    if (!expr) return null;
    return nextCronTime(expr, tz, from);
  },
};
