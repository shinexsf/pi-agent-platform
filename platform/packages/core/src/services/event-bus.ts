/**
 * 进程内事件总线 —— 插件之间**唯一**的协作通道。
 *
 * 为什么需要它：通知、定时任务、im 都是插件，谁也不该 import 谁。定时任务 run 失败
 * 要进收件箱，就只能靠一个内核里的、匿名的发布/订阅点：
 *
 *   scheduler.emit('scheduler.run.failed', {...})
 *        ↓（双方互不相识）
 *   notifications.subscribe('scheduler.run.failed', …)
 *
 * 语义（与 core-sdk 的会话订阅契约同一条）：
 * - **无回执**：emit 不等任何人，返回值是 void
 * - **同步派发**：订阅者在 emit 的调用栈里跑，所以订阅者自己必须轻
 * - **慢订阅者丢弃不回压**：不排队、不缓冲；emit 期间新产生的事件不会重入派发
 * - **抛错隔离**：单个订阅者抛错只记日志，不影响其它订阅者与发布方
 * - 不做：跨进程（worker ↔ master）、持久化、重放、通配符
 */

import { childLogger } from '../logger.js';

const logger = childLogger('event-bus');

export interface EventBus {
  /** 发布。无回执；无订阅者时静默丢弃。 */
  emit(topic: string, payload?: unknown): void;
  /** 订阅。返回幂等退订。 */
  subscribe(topic: string, fn: (payload: unknown) => void): () => void;
  /** 当前订阅数（验收 / 归零断言用）。 */
  subscriberCount(topic?: string): number;
  /** 清空所有订阅（进程级兜底，插件卸载走各自的 disposer）。 */
  clear(): void;
}

export function createEventBus(): EventBus {
  const topics = new Map<string, Set<(payload: unknown) => void>>();

  return {
    emit(topic, payload) {
      const listeners = topics.get(topic);
      if (!listeners || listeners.size === 0) return;
      // 快照：订阅者在回调里退订不影响本轮派发。
      for (const fn of [...listeners]) {
        try {
          fn(payload);
        } catch (err) {
          logger.warn({ err: String(err), topic }, 'event listener threw — ignored');
        }
      }
    },

    subscribe(topic, fn) {
      let set = topics.get(topic);
      if (!set) {
        set = new Set();
        topics.set(topic, set);
      }
      set.add(fn);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        set.delete(fn);
        if (set.size === 0) topics.delete(topic);
      };
    },

    subscriberCount(topic) {
      if (topic) return topics.get(topic)?.size ?? 0;
      let total = 0;
      for (const set of topics.values()) total += set.size;
      return total;
    },

    clear() {
      topics.clear();
    },
  };
}
