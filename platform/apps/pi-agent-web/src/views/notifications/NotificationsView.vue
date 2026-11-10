<script setup lang="ts">
/**
 * NotificationsView — `/notifications` inbox (change: trigger-scheduling).
 *
 * Read-only by design: notifications are not a conversation. Acting on one
 * means jumping to the session / trigger it points at.
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { NotificationDTO, NotificationSeverity } from '@pi-agent-platform/shared-types';
import AppIcon from '../../components/ui/AppIcon.vue';
import { toast } from '../../composables/useFeedback';
import { absoluteTime, relativeTime } from '../../composables/useTriggers';
import { useNotifications } from '../../composables/useNotifications';

const router = useRouter();
const { items, loading, error, unreadCount, load, markRead, markAllRead } = useNotifications();

const filter = ref<'all' | 'unread' | NotificationSeverity>('all');

const visible = computed(() => items.value);

async function refresh() {
  await load({
    unread: filter.value === 'unread',
    severity: filter.value === 'info' || filter.value === 'warning' || filter.value === 'error' ? filter.value : undefined,
  });
}

onMounted(refresh);

function setFilter(next: typeof filter.value) {
  filter.value = next;
  void refresh();
}

async function openNotification(item: NotificationDTO) {
  if (!item.readAt) await markRead(item.id);
  if (item.actionUrl) {
    // Deep links are server-built (`/chat/:id`, `/triggers/:id`) — same origin.
    void router.push(item.actionUrl);
  } else {
    toast('已标记为已读', 'success');
  }
}

async function readAll() {
  await markAllRead();
  await refresh();
  toast('全部标为已读', 'success');
}
</script>

<template>
  <section class="page-shell" aria-labelledby="notifications-title">
    <div class="page-heading">
      <div class="page-heading-copy">
        <h1 id="notifications-title" class="page-title">通知</h1>
        <p class="page-subtitle">
          只读收件箱 —— 通知由 agent 主动调用 <code>postNotification</code>，或触发器失败产生；要回复请进会话
        </p>
      </div>
      <div class="page-actions">
        <span class="page-count">{{ unreadCount }} 未读</span>
        <button class="btn btn-secondary" type="button" :disabled="unreadCount === 0" @click="readAll">
          全部已读
        </button>
      </div>
    </div>

    <div class="surface-panel" :aria-busy="loading">
      <div class="panel-toolbar">
        <div class="panel-toolbar-group chips">
          <button type="button" class="filter-chip" :class="{ active: filter === 'all' }" @click="setFilter('all')">全部</button>
          <button type="button" class="filter-chip" :class="{ active: filter === 'unread' }" @click="setFilter('unread')">未读</button>
          <button type="button" class="filter-chip" :class="{ active: filter === 'error' }" @click="setFilter('error')">错误</button>
          <button type="button" class="filter-chip" :class="{ active: filter === 'warning' }" @click="setFilter('warning')">警告</button>
        </div>
        <div class="panel-toolbar-group">
          <button class="btn btn-secondary btn-icon" type="button" :disabled="loading" aria-label="刷新通知" @click="refresh()">
            <AppIcon name="refresh" :size="16" />
          </button>
        </div>
      </div>

      <div v-if="loading" class="loading-caption">加载中…</div>

      <div v-else-if="error" class="state-panel">
        <div class="state-content">
          <span class="state-icon"><AppIcon name="alert" :size="23" /></span>
          <h2 class="state-title">通知加载失败</h2>
          <p class="state-copy">{{ error }}</p>
          <button class="btn btn-secondary state-action" type="button" @click="refresh()">重试</button>
        </div>
      </div>

      <div v-else-if="visible.length === 0" class="state-panel">
        <div class="state-content">
          <span class="state-icon"><AppIcon name="bell" :size="23" /></span>
          <h2 class="state-title">暂无通知</h2>
          <p class="state-copy">
            通知只在三种情况下出现：agent 主动调用 <code>postNotification</code>、触发器执行失败、平台自身异常。通知只写进这个收件箱，平台不做外部推送。
          </p>
        </div>
      </div>

      <ul v-else class="notification-list">
        <li
          v-for="item in visible"
          :key="item.id"
          class="notification-row"
          :class="[`sev-${item.severity}`, { unread: !item.readAt }]"
          @click="openNotification(item)"
        >
          <div class="notification-main">
            <div class="notification-title-row">
              <span class="severity-chip">{{ item.severity }}</span>
              <strong class="notification-title">{{ item.title }}</strong>
              <span class="notification-time" :title="absoluteTime(item.createdAt)">{{ relativeTime(item.createdAt) }}</span>
            </div>
            <p class="notification-body">{{ item.body }}</p>
            <div class="notification-meta">
              <span class="muted">{{ item.source }}</span>
              <span v-if="item.actionUrl" class="open-link">打开 →</span>
              <span v-if="!item.readAt" class="unread-dot" aria-label="未读" />
            </div>
          </div>
        </li>
      </ul>
    </div>
  </section>
</template>

<style scoped>
.page-subtitle {
  margin: 6px 0 0;
  max-width: 62ch;
  color: var(--text-tertiary);
  font-size: 0.86rem;
}

.chips {
  gap: 8px;
}

.filter-chip {
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-secondary);
  font-size: 0.8rem;
  cursor: pointer;
}

.filter-chip.active {
  border-color: var(--accent, #3b82f6);
  background: var(--surface-hover);
  color: var(--text);
}

.notification-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.notification-row {
  position: relative;
  padding: 14px 18px 14px 22px;
  border-bottom: 1px solid var(--border-subtle);
  cursor: pointer;
}

.notification-row::before {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 3px;
  background: var(--border-strong);
  content: '';
}

.notification-row.sev-info::before {
  background: #3b82f6;
}

.notification-row.sev-warning::before {
  background: #f59e0b;
}

.notification-row.sev-error::before {
  background: #dc2626;
}

.notification-row.unread {
  background: color-mix(in srgb, var(--surface-hover) 60%, transparent);
}

.notification-row:hover {
  background: var(--surface-hover);
}

.notification-title-row {
  display: flex;
  gap: 10px;
  align-items: baseline;
}

.severity-chip {
  color: var(--text-tertiary);
  font-size: 0.72rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.notification-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 0.9rem;
}

.notification-time {
  flex: 0 0 auto;
  color: var(--text-tertiary);
  font-size: 0.76rem;
}

.notification-body {
  overflow: hidden;
  display: -webkit-box;
  margin: 6px 0 0;
  color: var(--text-secondary);
  font-size: 0.84rem;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-height: 1.5;
  white-space: pre-wrap;
}

.notification-meta {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 6px;
  font-size: 0.76rem;
}

.muted {
  color: var(--text-tertiary);
}

.open-link {
  color: var(--accent, #3b82f6);
}

.unread-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #3b82f6;
}

.loading-caption {
  padding: 18px;
  color: var(--text-tertiary);
  font-size: 0.84rem;
}
</style>
