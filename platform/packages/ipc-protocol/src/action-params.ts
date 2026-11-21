/**
 * 动作入参校验（change: plugin-actions-contract / D7）—— **一处实现，三个错误面**。
 *
 * 三个面用同一份 `params` schema：
 * - 工具：校验失败 → `isError` tool result（模型能读懂并改参数）
 * - service / 反向方法：失败 → 抛错（调用方是代码，异常才是它的语言）
 * - HTTP：失败 → 400 + 原文（外部客户端看得见）
 *
 * 覆盖的是 **JSON Schema 的常用子集**（type / enum / const / required / properties /
 * additionalProperties / items / min-max / 长度 / pattern / allOf-anyOf-oneOf / not）。
 * 不认识的关帧被忽略而不是报错：schema 归作者，平台不该因为作者用了 `$ref` 就拒收整个插件；
 * 但被忽略这件事进 debug 日志，排查时看得见。
 */

export type ParamCheck = { ok: true } | { ok: false; message: string };

const IGNORED_KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$defs', 'definitions', 'title', 'description', 'default',
  'examples', 'format', 'deprecated', 'readOnly', 'writeOnly', 'uniqueItems',
  'multipleOf', 'minProperties', 'maxProperties', 'propertyNames', 'patternProperties',
  'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'contentEncoding', 'contentMediaType',
]);

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesType(value: unknown, type: unknown): boolean {
  if (Array.isArray(type)) return type.some((t) => matchesType(value, t));
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeOf(value) === 'object';
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      // 不认识的 type：不判（schema 归作者，平台不猜）
      return true;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeOf(a) === 'object' && typeOf(b) === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.join() !== kb.join()) return false;
    return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

/** 递归校验。`path` 只用于错误文案（`$.items[2].name` 这种）。 */
function check(schema: unknown, value: unknown, path: string, ignored: Set<string>): ParamCheck {
  if (schema === true || schema === undefined) return { ok: true };
  if (schema === false) return { ok: false, message: `${path}: schema 为 false，任何值都非法` };
  if (typeOf(schema) !== 'object') return { ok: true };
  const s = schema as Record<string, unknown>;

  for (const key of Object.keys(s)) {
    if (IGNORED_KEYWORDS.has(key)) continue;
    if (
      !['type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items',
        'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
        'minLength', 'maxLength', 'pattern', 'allOf', 'anyOf', 'oneOf', 'not'].includes(key)
    ) {
      ignored.add(key);
    }
  }

  if (s.type !== undefined && !matchesType(value, s.type)) {
    return { ok: false, message: `${path}: 期望 ${JSON.stringify(s.type)}，实际 ${typeOf(value)}` };
  }
  if (Array.isArray(s.enum) && !s.enum.some((v) => deepEqual(v, value))) {
    return { ok: false, message: `${path}: 期望其中之一 ${JSON.stringify(s.enum)}，实际 ${JSON.stringify(value)}` };
  }
  if ('const' in s && !deepEqual(s.const, value)) {
    return { ok: false, message: `${path}: 期望固定值 ${JSON.stringify(s.const)}` };
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) return { ok: false, message: `${path}: 不能小于 ${s.minimum}` };
    if (typeof s.maximum === 'number' && value > s.maximum) return { ok: false, message: `${path}: 不能大于 ${s.maximum}` };
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) return { ok: false, message: `${path}: 必须大于 ${s.exclusiveMinimum}` };
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) return { ok: false, message: `${path}: 必须小于 ${s.exclusiveMaximum}` };
  }
  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) return { ok: false, message: `${path}: 长度不能小于 ${s.minLength}` };
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) return { ok: false, message: `${path}: 长度不能大于 ${s.maxLength}` };
    if (typeof s.pattern === 'string') {
      try {
        if (!new RegExp(s.pattern).test(value)) return { ok: false, message: `${path}: 不匹配 /${s.pattern}/` };
      } catch {
        /* 作者的 pattern 写坏了：不判，交给日志 */
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) return { ok: false, message: `${path}: 元素数不能少于 ${s.minItems}` };
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) return { ok: false, message: `${path}: 元素数不能多于 ${s.maxItems}` };
    if (s.items !== undefined) {
      for (const [i, item] of value.entries()) {
        const res = check(s.items, item, `${path}[${i}]`, ignored);
        if (!res.ok) return res;
      }
    }
  }
  if (typeOf(value) === 'object') {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(s.required)) {
      const missing = s.required.filter((k) => typeof k === 'string' && !(k in obj));
      if (missing.length > 0) return { ok: false, message: `${path}: 缺少必填字段 ${missing.join(', ')}` };
    }
    const props = typeOf(s.properties) === 'object' ? (s.properties as Record<string, unknown>) : undefined;
    if (props) {
      for (const [key, sub] of Object.entries(props)) {
        if (!(key in obj)) continue;
        const res = check(sub, obj[key], `${path}.${key}`, ignored);
        if (!res.ok) return res;
      }
    }
    if (s.additionalProperties === false && props) {
      const allowed = new Set(Object.keys(props));
      const extra = Object.keys(obj).filter((k) => !allowed.has(k));
      if (extra.length > 0) return { ok: false, message: `${path}: 不认识的字段 ${extra.join(', ')}` };
    }
  }
  if (Array.isArray(s.allOf)) {
    for (const sub of s.allOf) {
      const res = check(sub, value, path, ignored);
      if (!res.ok) return res;
    }
  }
  if (Array.isArray(s.anyOf)) {
    const results = s.anyOf.map((sub) => check(sub, value, path, ignored));
    if (!results.some((r) => r.ok)) {
      const first = results.find((r) => !r.ok) as { message: string } | undefined;
      return { ok: false, message: `${path}: 不满足 anyOf（${first?.message ?? '无匹配分支'}）` };
    }
  }
  if (Array.isArray(s.oneOf)) {
    const okCount = s.oneOf.filter((sub) => check(sub, value, path, ignored).ok).length;
    if (okCount !== 1) return { ok: false, message: `${path}: oneOf 需要恰好匹配 1 个分支，实际 ${okCount}` };
  }
  if (s.not !== undefined && check(s.not, value, path, ignored).ok) {
    return { ok: false, message: `${path}: 命中了 not 分支` };
  }
  return { ok: true };
}

/**
 * 校验一次入参。
 *
 * 返回被忽略的关帧（调用方决定是打 debug 日志还是丢掉）—— 让"校验器覆盖不到的作者写法"
 * 可发现，而不是静默放过。
 */
export function validateParams(
  schema: Record<string, unknown> | undefined,
  value: unknown,
): ParamCheck & { ignored?: string[] } {
  if (!schema) return { ok: true };
  const ignored = new Set<string>();
  const res = check(schema, value, '$', ignored);
  return ignored.size > 0 ? { ...res, ignored: [...ignored] } : res;
}
