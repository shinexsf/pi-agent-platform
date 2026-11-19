/**
 * webhook 的类型（server facet 内部 + web facet 的镜像契约）。
 *
 * web facet 不能 import 这个文件（它在 server 目录下、引用 node 侧代码），
 * 所以 web 侧自己写一份结构等价的类型 —— 契约的唯一来源是 REST 响应。
 */

export type SessionMode = 'new' | 'reuse';
/** 收到事件时目标会话正忙（agent 还在流式输出）怎么办。 */
export type BusyPolicy = 'followUp' | 'steer' | 'skip';
/** **只表示"消息有没有送进 agent"**，不表示 agent 干得怎么样。 */
export type DeliveryStatus = 'delivered' | 'skipped' | 'failed';
export type DeliveryTrigger = 'http' | 'manual' | 'plugin';

export interface HookDTO {
  id: string;
  agentId: string;
  name: string;
  /** 事件到达时要执行的指令（进信封的 `<instruction>`）。 */
  prompt: string;
  sessionMode: SessionMode;
  /** `reuse` 的绑定目标；`null` = 首次投递时创建并回填。 */
  sessionId: string | null;
  busyPolicy: BusyPolicy;
  /** Bearer secret（明文存库，页面明文展示 —— 见 design D2）。 */
  secret: string;
  enabled: boolean;
  deliveriesCount: number;
  lastDeliveredAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface DeliveryDTO {
  id: string;
  hookId: string;
  status: DeliveryStatus;
  reason: string | null;
  triggeredBy: DeliveryTrigger;
  idempotencyKey: string | null;
  /** 原始 body 的字节数（截断前）。 */
  payloadBytes: number | null;
  sessionId: string | null;
  receivedAt: number;
  finishedAt: number | null;
}

export interface HookRow {
  id: string;
  agent_id: string;
  name: string;
  prompt: string;
  session_mode: SessionMode;
  session_id: string | null;
  busy_policy: BusyPolicy;
  secret: string;
  enabled: number;
  deliveries_count: number;
  last_delivered_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DeliveryRow {
  id: string;
  hook_id: string;
  status: DeliveryStatus;
  reason: string | null;
  triggered_by: DeliveryTrigger;
  idempotency_key: string | null;
  payload_bytes: number | null;
  session_id: string | null;
  received_at: number;
  finished_at: number | null;
}

export interface CreateHookInput {
  agentId?: string;
  name?: string;
  prompt?: string;
  sessionMode?: SessionMode;
  sessionId?: string;
  busyPolicy?: BusyPolicy;
}

export interface UpdateHookInput extends CreateHookInput {
  enabled?: boolean;
}

export interface DispatchResult {
  status: DeliveryStatus;
  deliveryId?: string;
  sessionId?: string;
  reason?: string;
  /** 幂等命中：没有新建投递行。 */
  duplicate?: boolean;
  truncated?: boolean;
  payloadBytes?: number;
}
