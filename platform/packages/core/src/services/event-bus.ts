/**
 * 插件间广播总线（**带声明**）—— 进程内、0..n 订阅者、无业务返回值。
 *
 * 为什么需要它：通知、定时任务、webhook 都是插件，谁也不该 import 谁。失败要进收件箱，
 * 就只能靠一个内核里的、匿名的交汇点：
 *
 *   scheduler.publish('scheduler.run.failed', {...})
 *        ↓（双方互不相识）
 *   notifications.subscribe('scheduler.run.failed', …)
 *
 * 与 `events` 的区别：`events` 是"发给浏览器"（worker → server → SSE），方向相反。
 *
 * ## 契约（每一条都对应一个可机械校验的行为）
 *
 * - **topic 必须先声明**：`declare(pluginId, topic, { declaredBy })`，前缀 MUST 等于声明者 id。
 *   未声明的 topic 发布 → `{ ok:false, reason:'unknown-topic' }`（拒绝，不静默成功）。
 * - **owner 双向管控**：`publisher` 声明的 topic 只有声明者能发（防冒名）；
 *   `subscriber` 声明的 topic 只有声明者能收（防抢单）。越权 → `not-owner`。
 * - **返回值一律丢弃**：handler 的返回值不会到发布方手里 —— 要业务数据请用 `host.services`。
 *   这条是机制（不是文档约定）：`publish` / `publishAndWait` 只统计成败。
 * - **无订阅者是正常态**：`{ ok:true, delivered:0 }`，不报错、不加 error 日志。
 * - **同步变体** `publishAndWait`：等处理完成，handler 抛错计入 `failed` 而**不外抛**；
 *   超时计入 `failed` 且**不取消**仍在执行的 handler。
 * - **pending 订阅**：topic 尚未声明时 `subscribe` 不报错，返回 `state:'pending'`，
 *   声明发生时自动接上（装载顺序是目录扫描顺序，判存在必 flaky）。
 *
 * 不做：跨进程（worker ↔ master）、持久化、重放、通配符、payload schema 校验。
 */

import { childLogger } from '../logger.js';

const logger = childLogger('plugin-bus');

/** 谁拥有这个 topic 的契约。 */
export type TopicDeclarer = 'publisher' | 'subscriber';

export type BusFailure = 'unknown-topic' | 'not-owner' | 'invalid-topic';

export interface PublishResult {
  ok: boolean;
  delivered: number;
  reason?: BusFailure;
}

export interface PublishAndWaitResult {
  ok: boolean;
  handled: number;
  failed: number;
  timedOut: number;
  reason?: BusFailure;
}

export interface SubscribeResult {
  dispose: () => void;
  /** `pending` = topic 尚未声明（等对方装载），`matched` = 已生效。 */
  state: 'matched' | 'pending';
}

export interface TopicInfo {
  topic: string;
  owner: string;
  declaredBy: TopicDeclarer;
  /** 已生效的订阅数。 */
  subscribers: number;
  /** 等待该 topic 被声明的订阅数（装载顺序导致的过渡态）。 */
  pending: number;
  lastPublishAt: string | null;
}

interface Subscription {
  pluginId: string;
  fn: (payload: unknown) => void;
  state: 'matched' | 'pending';
}

interface TopicEntry {
  topic: string;
  owner: string;
  declaredBy: TopicDeclarer;
  subscribers: Subscription[];
  lastPublishAt: string | null;
}

export interface DeclareOptions {
  declaredBy: TopicDeclarer;
}

export interface PluginBus {
  /** 声明 topic。同 owner 同名幂等覆盖；前缀不符 / owner 冲突 → 拒绝。 */
  declare(pluginId: string, topic: string, options: DeclareOptions): { ok: boolean; reason?: BusFailure };
  /** 广播（不等处理）。 */
  publish(pluginId: string, topic: string, payload?: unknown): PublishResult;
  /** 同步广播：等所有 handler 结束，只回报成败。 */
  publishAndWait(
    pluginId: string,
    topic: string,
    payload?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<PublishAndWaitResult>;
  /** 订阅（可能 pending）。 */
  subscribe(pluginId: string, topic: string, fn: (payload: unknown) => void): SubscribeResult;
  /** 目录：全部已声明 topic 的可观测状态。 */
  topics(): TopicInfo[];
  /** 某插件拥有的 topic（查询面用）。 */
  topicsOf(pluginId: string): TopicInfo[];
  /** 卸载兜底：撤销该插件的全部订阅与声明。 */
  disposePlugin(pluginId: string): void;
  /** 已生效订阅总数（验收 / 归零断言用）。 */
  subscriberCount(topic?: string): number;
  /** 清空（进程级兜底）。 */
  clear(): void;
}

/** topic 名 MUST 是 `<pluginId>.<类别>`。 */
function hasOwnerPrefix(pluginId: string, topic: string): boolean {
  return topic.startsWith(`${pluginId}.`) && topic.length > pluginId.length + 1;
}

const DEFAULT_WAIT_TIMEOUT_MS = 5_000;

export function createPluginBus(): PluginBus {
  const topics = new Map<string, TopicEntry>();

  /** pending 订阅：topic 名 → 订阅（不在 topics 里，避免"未声明却可见"）。 */
  const pending = new Map<string, Subscription[]>();

  /**
   * 统一退订：一个订阅可能从 pending 列表被提升到 topic 的 subscribers 里，
   * 所以 dispose MUST 两处都找 —— 否则"先订阅后声明"的场景会静默泄漏。
   */
  const removeSub = (topic: string, sub: Subscription): void => {
    const list = pending.get(topic);
    if (list) {
      const at = list.indexOf(sub);
      if (at >= 0) list.splice(at, 1);
      if (list.length === 0) pending.delete(topic);
    }
    const entry = topics.get(topic);
    if (entry) {
      const at = entry.subscribers.indexOf(sub);
      if (at >= 0) entry.subscribers.splice(at, 1);
    }
  };

  const pendingFor = (topic: string): Subscription[] => {
    let list = pending.get(topic);
    if (!list) {
      list = [];
      pending.set(topic, list);
    }
    return list;
  };

  return {
    declare(pluginId, topic, options) {
      if (!hasOwnerPrefix(pluginId, topic)) {
        logger.error({ pluginId, topic }, 'bus.declare rejected: topic 必须以「插件 id.」为前缀');
        return { ok: false, reason: 'invalid-topic' };
      }
      const declaredBy: TopicDeclarer = options?.declaredBy === 'subscriber' ? 'subscriber' : 'publisher';
      const existing = topics.get(topic);

      if (existing && existing.owner !== pluginId) {
        logger.error({ pluginId, topic, owner: existing.owner }, 'bus.declare rejected: 该 topic 已被别的插件声明');
        return { ok: false, reason: 'not-owner' };
      }

      // 幂等覆盖：reload 会重跑 init，报错必炸；已建立的订阅保留（它们属于各自的插件）。
      const entry: TopicEntry = existing ?? {
        topic,
        owner: pluginId,
        declaredBy,
        subscribers: [],
        lastPublishAt: null,
      };
      entry.declaredBy = declaredBy;

      // 把等待中的订阅接上；`subscriber` 型 topic 只接受 owner 自己的订阅。
      const waiting = pending.get(topic);
      if (waiting && waiting.length > 0) {
        for (const sub of waiting) {
          if (declaredBy === 'subscriber' && sub.pluginId !== pluginId) {
            logger.warn(
              { topic, pluginId: sub.pluginId, owner: pluginId },
              'bus: pending 订阅被拒 —— 该 topic 为 subscriber 型，只有 owner 能收',
            );
            continue;
          }
          sub.state = 'matched';
          entry.subscribers.push(sub);
        }
        pending.delete(topic);
      }

      topics.set(topic, entry);
      return { ok: true };
    },

    publish(pluginId, topic, payload) {
      const entry = topics.get(topic);
      if (!entry) {
        logger.debug({ pluginId, topic }, 'bus.publish: unknown-topic');
        return { ok: false, delivered: 0, reason: 'unknown-topic' };
      }
      if (entry.declaredBy === 'publisher' && entry.owner !== pluginId) {
        logger.warn({ pluginId, topic, owner: entry.owner }, 'bus.publish rejected: 不是该 topic 的声明者');
        return { ok: false, delivered: 0, reason: 'not-owner' };
      }

      entry.lastPublishAt = new Date().toISOString();
      // 快照：订阅者在回调里退订不影响本轮派发。
      const listeners = [...entry.subscribers];
      for (const sub of listeners) {
        try {
          sub.fn(payload); // 返回值**故意丢弃** —— 业务数据只能走 services
        } catch (err) {
          logger.warn({ err: String(err), topic, pluginId: sub.pluginId }, 'bus listener threw — ignored');
        }
      }
      if (listeners.length === 0) {
        logger.debug({ topic, pluginId }, 'bus.publish: 无订阅者（正常态，delivered:0）');
      }
      return { ok: true, delivered: listeners.length };
    },

    async publishAndWait(pluginId, topic, payload, options) {
      const entry = topics.get(topic);
      if (!entry) return { ok: false, handled: 0, failed: 0, timedOut: 0, reason: 'unknown-topic' };
      if (entry.declaredBy === 'publisher' && entry.owner !== pluginId) {
        return { ok: false, handled: 0, failed: 0, timedOut: 0, reason: 'not-owner' };
      }

      entry.lastPublishAt = new Date().toISOString();
      const listeners = [...entry.subscribers];
      const timeoutMs = options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

      let handled = 0;
      let failed = 0;
      let timedOut = 0;

      await Promise.all(
        listeners.map(async (sub) => {
          const TIMEOUT = Symbol('timeout');
          const run = Promise.resolve()
            .then(() => sub.fn(payload))
            // 返回值丢弃；只有成败进统计
            .then(() => 'ok' as const)
            .catch((err) => {
              logger.warn({ err: String(err), topic, pluginId: sub.pluginId }, 'bus publishAndWait: handler threw');
              return 'failed' as const;
            });
          const raced = await Promise.race([
            run,
            new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), timeoutMs)),
          ]);
          if (raced === 'ok') handled += 1;
          else if (raced === 'failed') failed += 1;
          else {
            timedOut += 1;
            // 超时不取消：handler 仍在后台跑（契约明确）
            logger.debug({ topic, pluginId: sub.pluginId, timeoutMs }, 'bus publishAndWait: 订阅者超时（未取消）');
          }
        }),
      );

      return { ok: true, handled, failed, timedOut };
    },

    subscribe(pluginId, topic, fn) {
      const entry = topics.get(topic);

      if (!entry) {
        const sub: Subscription = { pluginId, fn, state: 'pending' };
        pendingFor(topic).push(sub);
        let done = false;
        return {
          state: 'pending',
          dispose: () => {
            if (done) return;
            done = true;
            removeSub(topic, sub);
          },
        };
      }

      if (entry.declaredBy === 'subscriber' && entry.owner !== pluginId) {
        logger.warn({ pluginId, topic, owner: entry.owner }, 'bus.subscribe rejected: 该 topic 只有声明者能收');
        // 返回一个永远不生效的订阅，状态用 pending 表达（不抛错，避免装载顺序敏感）
        let done = false;
        return {
          state: 'pending',
          dispose: () => {
            done = true;
            void done;
          },
        };
      }

      const sub: Subscription = { pluginId, fn, state: 'matched' };
      entry.subscribers.push(sub);
      let done = false;
      return {
        state: 'matched',
        dispose: () => {
          if (done) return;
          done = true;
          removeSub(topic, sub);
        },
      };
    },

    topics() {
      const out: TopicInfo[] = [];
      for (const entry of topics.values()) {
        out.push({
          topic: entry.topic,
          owner: entry.owner,
          declaredBy: entry.declaredBy,
          subscribers: entry.subscribers.length,
          pending: pending.get(entry.topic)?.length ?? 0,
          lastPublishAt: entry.lastPublishAt,
        });
      }
      // 只有 pending 订阅、还没有声明的 topic 也列出来（否则"我订阅了怎么没反应"无从排查）
      for (const [topic, subs] of pending) {
        if (topics.has(topic) || subs.length === 0) continue;
        out.push({ topic, owner: '(未声明)', declaredBy: 'publisher', subscribers: 0, pending: subs.length, lastPublishAt: null });
      }
      return out.sort((a, b) => a.topic.localeCompare(b.topic));
    },

    topicsOf(pluginId) {
      return this.topics().filter((t) => t.owner === pluginId);
    },

    disposePlugin(pluginId) {
      for (const [topic, entry] of topics) {
        entry.subscribers = entry.subscribers.filter((s) => s.pluginId !== pluginId);
        if (entry.owner === pluginId) topics.delete(topic);
      }
      for (const [topic, list] of pending) {
        const left = list.filter((s) => s.pluginId !== pluginId);
        if (left.length === 0) pending.delete(topic);
        else pending.set(topic, left);
      }
    },

    subscriberCount(topic) {
      if (topic) return topics.get(topic)?.subscribers.length ?? 0;
      let total = 0;
      for (const entry of topics.values()) total += entry.subscribers.length;
      return total;
    },

    clear() {
      topics.clear();
      pending.clear();
    },
  };
}
