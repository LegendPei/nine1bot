<script setup lang="ts">
import { ref } from 'vue'
import { AlertCircle, Check, Copy, Info, X } from 'lucide-vue-next'
import type { SessionNotification } from '../composables/useSession'
import { copyText } from '../utils/clipboard'

defineProps<{ notifications: SessionNotification[] }>()
const emit = defineEmits<{ (event: 'dismiss', notificationId: string): void }>()
const copiedId = ref<string | null>(null)
const copyFailedId = ref<string | null>(null)

function notificationTitle(notification: SessionNotification) {
  if (notification.type === 'error') return '操作未完成'
  if (notification.type === 'success') return '已完成'
  return '会话提示'
}

async function copyNotification(notification: SessionNotification) {
  const copied = await copyText(`${notification.sessionTitle}\n\n${notification.message}`)
  copiedId.value = copied ? notification.id : null
  copyFailedId.value = copied ? null : notification.id
}
</script>

<template>
  <div
    v-if="notifications.length > 0"
    class="notifications-container custom-scrollbar"
    aria-label="会话通知"
    aria-live="polite"
  >
    <div
      v-for="notification in notifications.slice().reverse()"
      :key="notification.id"
      class="notification-toast"
      :class="notification.type"
      :role="notification.type === 'error' ? 'alert' : 'status'"
    >
      <div class="notification-header">
        <div class="notification-icon" aria-hidden="true">
          <Check v-if="notification.type === 'success'" :size="17" />
          <AlertCircle v-else-if="notification.type === 'error'" :size="17" />
          <Info v-else :size="17" />
        </div>
        <div class="notification-heading">
          <span class="notification-title">{{ notificationTitle(notification) }}</span>
          <span class="notification-session">{{ notification.sessionTitle }}</span>
        </div>
        <button
          type="button"
          class="notification-close"
          :aria-label="`关闭会话「${notification.sessionTitle}」的${notificationTitle(notification)}通知`"
          title="关闭通知"
          @click="emit('dismiss', notification.id)"
        >
          <X :size="16" />
        </button>
      </div>
      <div class="notification-message custom-scrollbar" tabindex="0">{{ notification.message }}</div>
      <div v-if="notification.type === 'error'" class="notification-footer">
        <span class="notification-hint" role="status">{{ copyFailedId === notification.id ? '复制失败，可选中文字复制' : '关闭前将保留此提示' }}</span>
        <button type="button" class="notification-copy" @click="copyNotification(notification)">
          <Check v-if="copiedId === notification.id" :size="14" />
          <Copy v-else :size="14" />
          {{ copiedId === notification.id ? '已复制' : '复制详情' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notifications-container {
  position: fixed;
  top: calc(var(--header-height) + 12px + env(safe-area-inset-top, 0px));
  right: var(--space-lg);
  z-index: var(--z-overlay);
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(420px, calc(100vw - 48px));
  max-height: calc(100dvh - var(--header-height) - 36px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
  padding: 4px 4px 16px;
  overflow-y: auto;
  overscroll-behavior: contain;
  pointer-events: none;
}

.notification-toast {
  --notification-tone: var(--accent);
  flex-shrink: 0;
  width: 100%;
  padding: 16px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: 0 4px 8px -4px rgb(0 0 0 / 8%), 0 12px 32px -12px rgb(0 0 0 / 18%);
  pointer-events: auto;
  animation: notification-in 180ms var(--ease-smooth);
}
.notification-toast.success { --notification-tone: var(--success); }
.notification-toast.error { --notification-tone: var(--error); }
.notification-header { display: flex; align-items: flex-start; gap: 10px; }
.notification-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  flex-shrink: 0;
  color: var(--notification-tone);
  background: color-mix(in srgb, var(--notification-tone) 9%, transparent);
}
.notification-heading { display: flex; flex: 1; flex-direction: column; gap: 3px; min-width: 0; }
.notification-title { color: var(--text-primary); font-size: var(--text-base); font-weight: 600; line-height: 1.4; }
.notification-session { color: var(--text-muted); font-size: var(--text-sm); line-height: 1.5; overflow-wrap: anywhere; }
.notification-message {
  margin-top: 12px;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: var(--text-13);
  line-height: 1.65;
  max-height: min(36dvh, 300px);
  overflow-y: auto;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
  user-select: text;
  white-space: pre-wrap;
}
.notification-toast.error .notification-message {
  padding: 12px;
  background: color-mix(in srgb, var(--bg-tertiary) 45%, var(--bg-elevated));
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}
.notification-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.notification-hint { color: var(--text-muted); font-size: var(--text-xs); }
.notification-close,
.notification-copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 150ms ease, color 150ms ease;
}
.notification-close { width: 32px; height: 32px; margin: -4px -4px 0 0; padding: 0; }
.notification-copy { min-height: 30px; padding: 4px 8px; font-size: var(--text-sm); }
.notification-close:hover,
.notification-copy:hover { color: var(--text-primary); background: var(--hover-overlay); }
.notification-close:focus-visible,
.notification-copy:focus-visible,
.notification-message:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

@media (max-width: 640px) {
  .notifications-container { right: 8px; width: calc(100vw - 16px); }
  .notification-toast { padding: 14px; }
  .notification-close { width: 40px; height: 40px; margin-top: -6px; }
  .notification-copy { min-height: 40px; }
}
@keyframes notification-in {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (prefers-reduced-motion: reduce) {
  .notification-toast { animation: none; }
  .notification-close, .notification-copy { transition: none; }
}
</style>
