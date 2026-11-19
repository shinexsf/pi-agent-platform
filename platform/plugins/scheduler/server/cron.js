const FIELD_RANGES = [
  ["minutes", 0, 59],
  ["hours", 0, 23],
  ["daysOfMonth", 1, 31],
  ["months", 1, 12],
  ["daysOfWeek", 0, 6]
];
function parseField(raw, min, max, name) {
  const out = /* @__PURE__ */ new Set();
  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) throw new Error(`cron ${name}: empty list entry`);
    const [rangePartRaw, stepPart] = piece.split("/");
    const rangePart = rangePartRaw ?? "";
    const step = stepPart === void 0 ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) throw new Error(`cron ${name}: bad step "${piece}"`);
    let lo;
    let hi;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = stepPart === void 0 ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`cron ${name}: bad value "${piece}"`);
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron ${name}: "${piece}" out of range ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}
function parseCronExpr(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron: expected 5 fields (minute hour day month weekday), got ${parts.length}`);
  }
  const minRaw = parts[0];
  const hourRaw = parts[1];
  const domRaw = parts[2];
  const monRaw = parts[3];
  const dowRaw = parts[4];
  const raws = [minRaw, hourRaw, domRaw, monRaw, dowRaw];
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = FIELD_RANGES.map(
    ([key, min, max], i) => parseField(raws[i], min, max, String(key))
  );
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7);
    daysOfWeek.add(0);
  }
  if (daysOfMonth.size === 0 || months.size === 0 || hours.size === 0 || minutes.size === 0) {
    throw new Error("cron: expression never fires");
  }
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: domRaw.trim() !== "*",
    dowRestricted: dowRaw.trim() !== "*"
  };
}
const MIN_CRON_INTERVAL_MINUTES = 5;
const formatterCache = /* @__PURE__ */ new Map();
function formatterFor(tz) {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    formatterCache.set(tz, f);
  }
  return f;
}
function isValidTimeZone(tz) {
  try {
    formatterFor(tz).format(/* @__PURE__ */ new Date());
    return true;
  } catch {
    return false;
  }
}
function wallPartsAt(tz, utcMs) {
  const parts = formatterFor(tz).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second")
  };
}
function tzOffsetMs(tz, utcMs) {
  const p = wallPartsAt(tz, utcMs);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(utcMs / 1e3) * 1e3;
}
function wallToUtc(tz, wallMs) {
  const guess = wallMs - tzOffsetMs(tz, wallMs);
  const corrected = wallMs - tzOffsetMs(tz, guess);
  return corrected;
}
function matches(fields, p) {
  if (!fields.minutes.has(p.minute)) return false;
  if (!fields.hours.has(p.hour)) return false;
  if (!fields.months.has(p.month)) return false;
  const domHit = fields.daysOfMonth.has(p.day);
  const dowHit = fields.daysOfWeek.has(new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay());
  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}
function nextCronTime(expr, tz, from) {
  const fields = parseCronExpr(expr);
  if (!isValidTimeZone(tz)) throw new Error(`unknown timezone: ${tz}`);
  const start = wallPartsAt(tz, from);
  const wallStart = Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute, 0);
  const MAX_MINUTES = 4 * 366 * 24 * 60;
  let wall = wallStart + 6e4;
  for (let i = 0; i < MAX_MINUTES; i++, wall += 6e4) {
    const d = new Date(wall);
    const p = {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: 0
    };
    if (!matches(fields, p)) continue;
    const utc = wallToUtc(tz, wall);
    if (utc > from) return utc;
  }
  return null;
}
export {
  MIN_CRON_INTERVAL_MINUTES,
  isValidTimeZone,
  nextCronTime,
  parseCronExpr
};
