/**
 * system-envelope — 平台把**非用户消息**交给 agent 的唯一构造点。
 *
 * 为什么在内核：信封文本是**平台契约**（模型看到的必须是同一种形状，
 * `SYSTEM_EVENT_PROMPT_NOTICE` 也在 shared-types 里统一注入）。让每个插件各拼一份，
 * 就等于让"外部文本能否注入标签名/属性"取决于各插件的自觉。
 *
 * 形状（平台契约，与具体功能无关）：
 *
 *   <system-event v="1" kind="trigger" source="cron" name="disk-check"
 *                 fired="2026-11-06T09:00:00.000Z" run="run_01j…">
 *     <instruction>检查磁盘</instruction>
 *     <data format="json">{"alert":"cpu 98%"}</data>
 *   </system-event>
 *
 * 规则：
 * - 只有本函数能拼这个字符串；调用方传结构化字段，不可信输入永远进不到标签名/属性里
 * - 一个根标签 + `kind` 判别：新场景加 `kind`，不加根标签
 * - 唯一转义点：`</data` → `<\/data`
 * - `<instruction>` 原样保留（它是 prompt 本身，唯一的终止符是 `</instruction>`）
 */

export type SystemEnvelopeKind = 'trigger' | 'reminder' | 'system' | (string & {});

export interface SystemEnvelopeInput {
  kind: SystemEnvelopeKind;
  /** 机器可读来源（`cron` / `once` / 插件名）。 */
  source?: string;
  /** 人可读短名（任务名）。 */
  name?: string;
  /** ISO 时间戳。 */
  fired?: string;
  /** run id（用于日志 / runs 交叉引用）。 */
  run?: string;
  /** 任务正文。缺省为空（纯数据事件合法）。 */
  instruction?: string;
  /** 以 JSON 渲染进 `<data format="json">`。 */
  data?: unknown;
}

/** 只转义能破坏信封的 `</data` 序列。 */
function escapeData(json: string): string {
  return json.replace(/<\/data/gi, '<\\/data');
}

/** 属性值只由平台拼——仍然做引号转义。 */
function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function buildSystemEnvelope(input: SystemEnvelopeInput): string {
  const attrs: string[] = ['v="1"', `kind="${attr(input.kind)}"`];
  if (input.source) attrs.push(`source="${attr(input.source)}"`);
  if (input.name) attrs.push(`name="${attr(input.name)}"`);
  if (input.fired) attrs.push(`fired="${attr(input.fired)}"`);
  if (input.run) attrs.push(`run="${attr(input.run)}"`);

  const body: string[] = [];
  if (input.instruction !== undefined && input.instruction !== '') {
    body.push(`<instruction>${input.instruction}</instruction>`);
  }
  if (input.data !== undefined) {
    let json: string;
    try {
      json = JSON.stringify(input.data);
    } catch {
      json = JSON.stringify({ unserializable: String(input.data) });
    }
    if (json === undefined) json = 'null';
    body.push(`<data format="json">${escapeData(json)}</data>`);
  }

  return `<system-event ${attrs.join(' ')}>\n${body.join('\n')}\n</system-event>`;
}
