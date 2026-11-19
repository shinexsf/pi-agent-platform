/**
 * UI 与 API 共用的类型（server facet 内部 + web facet 编译期引用）。
 *
 * 注意：web facet 不能 import 这个文件（它在 server facet 目录下、且引用 node 侧代码），
 * 所以 web 侧自己写了一份结构等价的类型 —— 契约唯一来源是 REST 响应。
 */

export type ScheduleKind = 'cron' | 'once';
export type SessionMode = 'new' | 'reuse';
export type RunStatus = 'delivered' | 'skipped' | 'missed' | 'failed';
export type RunTrigger = 'schedule' | 'manual' | 'plugin';
/**
 * 到点时目标会话正忙（agent 还在流式输出）怎么办。
 *
 * - `followUp`：排队，等当前轮结束再送（默认 —— 不丢这一轮）
 * - `steer`：当前轮工具调用结束后插入（会打断 agent 正在做的事）
 * - `skip`：这一次不投，记 `skipped/busy`
 */
export type BusyPolicy = 'followUp' | 'steer' | 'skip';

export interface TaskDTO {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  scheduleKind: ScheduleKind;
  /** `cron` 时必填。 */
  cronExpr: string | null;
  /** `cron` 时必填（IANA）。 */
  timezone: string | null;
  /** `once` 时必填（ms）。 */
  at: number | null;
  sessionMode: SessionMode;
  /** `reuse` 的绑定目标；`null` = 首次触发时创建并回填。 */
  sessionId: string | null;
  busyPolicy: BusyPolicy;
  enabled: boolean;
  /** 下一个计划时刻；`null` = 不再触发。 */
  nextAt: number | null;
  maxRuns: number | null;
  runsCount: number;
  lastFiredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunDTO {
  id: string;
  taskId: string;
  /** **只表示"消息有没有送进 agent"**，不表示 agent 干得怎么样。 */
  status: RunStatus;
  reason: string | null;
  triggeredBy: RunTrigger;
  sessionId: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface TaskRow {
  id: string;
  agent_id: string;
  name: string;
  prompt: string;
  schedule_kind: ScheduleKind;
  cron_expr: string | null;
  timezone: string | null;
  at: number | null;
  session_mode: SessionMode;
  session_id: string | null;
  busy_policy: BusyPolicy;
  enabled: number;
  next_at: number | null;
  max_runs: number | null;
  runs_count: number;
  last_fired_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface RunRow {
  id: string;
  task_id: string;
  status: RunStatus;
  reason: string | null;
  triggered_by: RunTrigger;
  session_id: string | null;
  started_at: number;
  finished_at: number | null;
}
