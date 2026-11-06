/**
 * system-envelope — the platform's ONE way to hand a non-user message to an agent
 * (change: trigger-scheduling, capability `system-envelope`).
 *
 * Shape (platform contract, not trigger-specific):
 *
 *   <system-event v="1" kind="trigger" source="cron" name="disk-check"
 *                 fired="2026-11-06T09:00:00+08:00" run="run_01j…">
 *     <instruction>检查磁盘</instruction>
 *     <data format="json">{"alert":"cpu 98%"}</data>
 *   </system-event>
 *
 * Rules:
 * - Only this function may build the string. Callers pass structured fields, so
 *   untrusted input (user prompt text, webhook body) can never reach a tag name
 *   or attribute — it can only appear inside `<instruction>` / `<data>`.
 * - One root tag + `kind` discriminant: new scenarios add a `kind`, never a new
 *   root tag, and the system-prompt notice stays a single line.
 * - Single escape point: `</data` inside JSON becomes `<\/data`.
 * - `custom` messages are converted to `role:"user"` by pi's `convertToLlm()`,
 *   so the envelope (not the message role) is what tells the model this is
 *   platform-originated. Switching to `sendCustomMessage` later keeps the text
 *   byte-identical.
 */

export type SystemEnvelopeKind = 'trigger' | 'reminder' | 'system' | (string & {});

export interface SystemEnvelopeInput {
  kind: SystemEnvelopeKind;
  /** Machine-readable origin (`cron` / `once` / `webhook` / plugin source name). */
  source?: string;
  /** Human-facing short name (trigger name). */
  name?: string;
  /** ISO timestamp of the event. */
  fired?: string;
  /** Run id for cross-referencing logs / runs. */
  run?: string;
  /** The task. Defaults to empty (data-only events are legal). */
  instruction?: string;
  /** Payload rendered as JSON inside `<data format="json">`. */
  data?: unknown;
}

/** Escape only what can break the envelope: the `</data` sequence. */
function escapeData(json: string): string {
  return json.replace(/<\/data/gi, '<\\/data');
}

/** Attribute values are built by the platform only — still quote-escape them. */
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
    // Instruction is plain text; `</` inside it cannot close `<instruction>`
    // because the only meaningful terminator is `</instruction>` — keep the
    // text verbatim (it is the actual user/agent-authored prompt).
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

/** Convenience for trigger firings (keeps attribute names in one place). */
export function buildTriggerEnvelope(input: {
  name: string;
  source: string;
  firedAt: number;
  runId: string;
  instruction: string;
  payload?: unknown;
}): string {
  return buildSystemEnvelope({
    kind: 'trigger',
    source: input.source,
    name: input.name,
    fired: new Date(input.firedAt).toISOString(),
    run: input.runId,
    instruction: input.instruction,
    data: input.payload,
  });
}
