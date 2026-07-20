<script setup lang="ts">
import { AlertTriangle, Check, Info, X } from 'lucide-vue-next'
import type { SessionNotification } from '../composables/useSession'

defineProps<{
  notifications: SessionNotification[]
}>()

const emit = defineEmits<{
  (event: 'dismiss', notificationId: string): void
}>()

function notificationTitle(notification: SessionNotification) {
  if (notification.type === 'error') {
    return `会话「${notification.sessionTitle}」运行失败`
  }
  return notification.sessionTitle
}
</script>

<template>
  <div
    v-if="notifications.length > 0"
    class="notifications-container"
    aria-live="polite"
  >
    <div
      v-for="notification in notifications.slice().reverse()"
      :key="notification.id"
      class="notification-toast"
      :class="notification.type"
      :role="notification.type === 'error' ? 'alert' : 'status'"
    >
      <div class="notification-icon" aria-hidden="true">
        <Check v-if="notification.type === 'success'" :size="16" />
        <AlertTriangle v-else-if="notification.type === 'error'" :size="16" />
        <Info v-else :size="16" />
      </div>

      <div class="notification-content">
        <span class="notification-title">{{ notificationTitle(notification) }}</span>
        <span class="notification-message" tabindex="0">{{ notification.message }}</span>
      </div>

      <button
        type="button"
        class="notification-close"
        :aria-label="`关闭${notificationTitle(notification)}通知`"
        @click="emit('dismiss', notification.id)"
      >
        <X :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.notifications-container {
  position: fixed;
  right: var(--space-lg);
  bottom: var(--space-lg);
  z-index: var(--z-overlay);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  width: min(480px, calc(100vw - var(--space-lg) - var(--space-lg)));
  max-height: calc(100vh - var(--space-lg) - var(--space-lg));
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-gutter: stable;
}

.notification-toast {
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  width: 100%;
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  animation: slide-in 0.3s var(--ease-smooth);
}

.notification-toast.success {
  border-color: var(--success);
}

.notification-toast.info {
  border-color: var(--accent);
}

.notification-toast.error {
  border-color: var(--error);
  background: color-mix(in srgb, var(--error-subtle) 45%, var(--bg-elevated) 55%);
}

.notification-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  flex-shrink: 0;
}

.notification-toast.success .notification-icon {
  color: var(--success);
  background: rgba(34, 197, 94, 0.2);
}

.notification-toast.info .notification-icon {
  color: var(--accent);
  background: rgba(var(--accent-rgb), 0.15);
}

.notification-toast.error .notification-icon {
  color: var(--error);
  background: var(--error-subtle);
}

.notification-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.notification-title {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 0.875rem;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notification-toast.error .notification-title {
  overflow: visible;
  overflow-wrap: anywhere;
  text-overflow: clip;
  white-space: normal;
}

.notification-message {
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.55;
  overflow-wrap: anywhere;
  user-select: text;
  white-space: pre-wrap;
  word-break: break-word;
}

.notification-toast.error .notification-message {
  max-height: min(45vh, 360px);
  padding-right: var(--space-xs);
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.notification-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.15s ease;
}

.notification-close:hover {
  color: var(--text-primary);
  background: var(--bg-tertiary);
}

.notification-close:focus-visible,
.notification-message:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@media (max-width: 640px) {
  .notifications-container {
    right: var(--space-sm);
    bottom: var(--space-sm);
    width: calc(100vw - var(--space-sm) - var(--space-sm));
  }
}

@keyframes slide-in {
  from {
    opacity: 0;
    transform: translateX(100%);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
</style>
