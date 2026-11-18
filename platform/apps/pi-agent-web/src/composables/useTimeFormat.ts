/**
 * 时间展示格式化（相对 / 绝对）。
 *
 * 与业务无关的纯展示工具：通知收件箱、触发器时代留下的调用点都用它。
 * 放在独立文件里而不是某个业务 composable 里，避免"删掉一个业务就把格式化工具带走"。
 */

/** 相对时间：`in 3m` / `5m ago` / `—`（空值）。 */
export function relativeTime(at: number | null | undefined): string {
  if (!at) return '—';
  const delta = at - Date.now();
  const abs = Math.abs(delta);
  const unit =
    abs < 60_000
      ? [`${Math.round(abs / 1000)}s`, `${Math.round(abs / 1000)}s`]
      : abs < 3_600_000
        ? [`${Math.round(abs / 60_000)}m`, `${Math.round(abs / 60_000)}m`]
        : abs < 86_400_000
          ? [`${Math.round(abs / 3_600_000)}h`, `${Math.round(abs / 3_600_000)}h`]
          : [`${Math.round(abs / 86_400_000)}d`, `${Math.round(abs / 86_400_000)}d`];
  return delta >= 0 ? `in ${unit[0]}` : `${unit[1]} ago`;
}

/** 绝对时间：`YYYY-MM-DD HH:mm`（本地时区）。 */
export function absoluteTime(at: number | null | undefined): string {
  if (!at) return '—';
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
