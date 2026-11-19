/**
 * cron 下次触发时间计算，零依赖（从旧触发器子系统原样迁入）。
 *
 * 为什么自研而不是引库：平台对 cron 的需求只有"给定 5 段表达式 + IANA 时区，
 * 算下一个触发时刻"。引库会带进秒级语法、@daily 别名、扩展字段这些**我们不想支持**
 * 的东西；而这 200 行的扫描循环最坏情况（`0 0 29 2 *`）约 500k 次整数步进 ~5ms，
 * 对"最小间隔 5 分钟"的调度器完全够用。
 *
 *
 * Wall-clock arithmetic in the trigger's timezone, then one conversion back to
 * UTC (with a DST re-check). No `Intl` calls inside the scan loop — a Feb-29
 * expression costs ~500k plain integer steps (~5 ms), which is fine for the
 * minimum 5-minute interval the platform enforces.
 *
 * Supported syntax (5 fields, no seconds):
 *   *   any
 *   a   exact
 *   a-b range
 *   * /n or a-b/n step
 *   a,b,c list (entries may be ranges or steps)
 */

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when day-of-month or day-of-week was restricted (`*` semantics differ). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELD_RANGES: Array<[keyof Omit<CronFields, 'domRestricted' | 'dowRestricted'>, number, number]> = [
  ['minutes', 0, 59],
  ['hours', 0, 23],
  ['daysOfMonth', 1, 31],
  ['months', 1, 12],
  ['daysOfWeek', 0, 6],
];

function parseField(raw: string, min: number, max: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (!piece) throw new Error(`cron ${name}: empty list entry`);
    const [rangePartRaw, stepPart] = piece.split('/');
    const rangePart = rangePartRaw ?? '';
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) throw new Error(`cron ${name}: bad step "${piece}"`);
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = stepPart === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`cron ${name}: bad value "${piece}"`);
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron ${name}: "${piece}" out of range ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCronExpr(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron: expected 5 fields (minute hour day month weekday), got ${parts.length}`);
  }
  const minRaw = parts[0]!;
  const hourRaw = parts[1]!;
  const domRaw = parts[2]!;
  const monRaw = parts[3]!;
  const dowRaw = parts[4]!;
  const raws = [minRaw, hourRaw, domRaw, monRaw, dowRaw];
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = FIELD_RANGES.map(([key, min, max], i) =>
    parseField(raws[i]!, min, max, String(key)),
  ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  // 7 = Sunday alias
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7);
    daysOfWeek.add(0);
  }
  // Sanity: the expression must be satisfiable within a month.
  if (daysOfMonth.size === 0 || months.size === 0 || hours.size === 0 || minutes.size === 0) {
    throw new Error('cron: expression never fires');
  }
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: domRaw.trim() !== '*',
    dowRestricted: dowRaw.trim() !== '*',
  };
}

/** Minutes between two cron firings must be >= this (platform guard). */
export const MIN_CRON_INTERVAL_MINUTES = 5;

// ── timezone helpers ────────────────────────────────────────────────────────

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    formatterFor(tz).format(new Date());
    return true;
  } catch {
    return false;
  }
}

interface WallParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallPartsAt(tz: string, utcMs: number): WallParts {
  const parts = formatterFor(tz).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** offset such that `utcMs + offset` reads as local wall time. */
function tzOffsetMs(tz: string, utcMs: number): number {
  const p = wallPartsAt(tz, utcMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Convert a naive wall-clock instant (as if UTC) in `tz` back to real UTC ms. */
function wallToUtc(tz: string, wallMs: number): number {
  const guess = wallMs - tzOffsetMs(tz, wallMs);
  const corrected = wallMs - tzOffsetMs(tz, guess);
  return corrected;
}

function matches(fields: CronFields, p: WallParts): boolean {
  if (!fields.minutes.has(p.minute)) return false;
  if (!fields.hours.has(p.hour)) return false;
  if (!fields.months.has(p.month)) return false;
  const domHit = fields.daysOfMonth.has(p.day);
  const dowHit = fields.daysOfWeek.has(new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay());
  // Cron semantics: when both dom and dow are restricted, either match is enough.
  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

/**
 * Next firing instant strictly after `from`, in the given timezone.
 * Returns null when nothing matches within ~4 years (e.g. `0 0 31 2 *`).
 */
export function nextCronTime(expr: string, tz: string, from: number): number | null {
  const fields = parseCronExpr(expr);
  if (!isValidTimeZone(tz)) throw new Error(`unknown timezone: ${tz}`);

  const start = wallPartsAt(tz, from);
  // Start from the next whole minute in wall time.
  const wallStart = Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute, 0);
  const MAX_MINUTES = 4 * 366 * 24 * 60;

  let wall = wallStart + 60_000;
  for (let i = 0; i < MAX_MINUTES; i++, wall += 60_000) {
    const d = new Date(wall);
    const p: WallParts = {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: 0,
    };
    if (!matches(fields, p)) continue;
    const utc = wallToUtc(tz, wall);
    if (utc > from) return utc;
  }
  return null;
}
