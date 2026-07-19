<script setup lang="ts">
import { computed, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { Message, MessagePart, FilePart } from '../api/client'
import AgentSteps from './AgentSteps.vue'
import { X, FileDown, File, Eye } from 'lucide-vue-next'
import { useFilePreview } from '../composables/useFilePreview'

interface Step { parts: MessagePart[]; isComplete: boolean }

const props = defineProps<{
  messages: Message[]
  isStreaming: boolean
}>()

// Collect all steps from all messages in this group
const allSteps = computed<Step[]>(() => {
  const steps: Step[] = []
  for (const message of props.messages) {
    let currentStep: Step | null = null
    for (const part of message.parts) {
      if (part.type === 'step-start') {
        currentStep = { parts: [], isComplete: false }
        steps.push(currentStep)
      } else if (part.type === 'step-finish') {
        if (currentStep) currentStep.isComplete = true
        currentStep = null
      } else if (part.type === 'tool' || part.type === 'reasoning') {
        if (currentStep) {
          currentStep.parts.push(part)
        } else {
          // tool/reasoning outside explicit steps — implicit completed step
          if (steps.length === 0 || steps[steps.length - 1].isComplete) {
            steps.push({ parts: [], isComplete: true })
          }
          steps[steps.length - 1].parts.push(part)
        }
      }
    }
  }
  return steps
})

// Collect all text/file outputs (always visible)
type OutputItem =
  | { type: 'text'; text: string; id: string }
  | { type: 'file'; part: MessagePart }

const textOutputs = computed<OutputItem[]>(() => {
  const outputs: OutputItem[] = []
  for (const message of props.messages) {
    for (const part of message.parts) {
      if (part.type === 'text' && !(part as any).synthetic && part.text) {
        outputs.push({ type: 'text', text: part.text, id: part.id })
      } else if (part.type === 'file') {
        outputs.push({ type: 'file', part })
      }
    }
  }
  return outputs
})

const markdownCache = new Map<string, string>()
const MARKDOWN_CACHE_LIMIT = 200

function formatText(text: string): string {
  // 流式期间文本持续增长，中间态进缓存只会冲刷 FIFO，直接渲染
  if (props.isStreaming) {
    try {
      return DOMPurify.sanitize(marked.parse(text) as string)
    } catch {
      return DOMPurify.sanitize(text)
    }
  }

  const cached = markdownCache.get(text)
  if (cached !== undefined) return cached

  let rendered: string
  try {
    rendered = DOMPurify.sanitize(marked.parse(text) as string)
  } catch {
    rendered = DOMPurify.sanitize(text)
  }
  markdownCache.set(text, rendered)
  if (markdownCache.size > MARKDOWN_CACHE_LIMIT) {
    const oldest = markdownCache.keys().next().value
    if (oldest !== undefined) markdownCache.delete(oldest)
  }
  return rendered
}

function isImageFile(part: MessagePart): boolean {
  return ((part as any).mime || '').startsWith('image/')
}

function resolveFileUrl(url: string): string {
  if (url.startsWith('file://')) {
    return `/file/upload?path=${encodeURIComponent(url.slice(7))}`
  }
  return url
}

const previewImageUrl = ref<string | null>(null)

const { openPreviewByPath } = useFilePreview()

// Collect all file attachments from tool state across all steps
const toolAttachments = computed<FilePart[]>(() => {
  const result: FilePart[] = []
  for (const message of props.messages) {
    for (const part of message.parts) {
      if (part.type === 'tool' && part.state?.attachments?.length) {
        for (const att of part.state.attachments) {
          if ((att as any).url) result.push(att as FilePart)
        }
      }
    }
  }
  return result
})

// Collect all preview_file tools (completed)
interface PreviewMeta {
  path: string
  filename?: string
  size?: number
  interactive?: boolean
  sessionID: string
}
const previewTools = computed<PreviewMeta[]>(() => {
  const result: PreviewMeta[] = []
  for (const message of props.messages) {
    for (const part of message.parts) {
      if (
        part.type === 'tool' &&
        (part.tool || '').toLowerCase() === 'preview_file' &&
        part.state?.status === 'completed' &&
        part.state?.metadata?.path
      ) {
        result.push({
          path: part.state.metadata.path as string,
          filename: part.state.metadata.filename as string | undefined,
          size: part.state.metadata.size as number | undefined,
          interactive: part.state.metadata.interactive as boolean | undefined,
          sessionID: part.sessionID
        })
      }
    }
  }
  return result
})

function downloadAttachment(att: FilePart) {
  let url = att.url
  if (url.startsWith('file://')) {
    url = `/file/download?path=${encodeURIComponent(url.slice(7))}`
  }
  const a = document.createElement('a')
  a.href = url
  a.download = att.filename || 'download'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const openingPreviewIdx = ref<number | null>(null)
async function openPreview(meta: PreviewMeta, idx: number) {
  openingPreviewIdx.value = idx
  try {
    await openPreviewByPath(meta.path, { interactive: meta.interactive, sessionID: meta.sessionID })
  } finally {
    openingPreviewIdx.value = null
  }
}
</script>

<template>
  <div class="agent-group">
    <!-- Steps: all steps from all consecutive messages in one fold -->
    <AgentSteps
      v-if="allSteps.length > 0"
      :steps="allSteps"
      :isStreaming="isStreaming"
    />

    <!-- Text / file outputs: always visible -->
    <template v-for="item in textOutputs" :key="item.type === 'text' ? item.id : (item.part as any).id">
      <div
        v-if="item.type === 'text'"
        class="markdown-content"
        v-html="formatText(item.text)"
      />
      <div v-else-if="item.type === 'file'" class="file-attachment">
        <img
          v-if="isImageFile(item.part)"
          :src="resolveFileUrl((item.part as any).url)"
          :alt="(item.part as any).filename || 'image'"
          class="uploaded-image"
          @click="previewImageUrl = resolveFileUrl((item.part as any).url)"
        />
        <a v-else :href="resolveFileUrl((item.part as any).url)" target="_blank" class="file-badge">
          <File :size="18" class="file-icon" />
          <span class="file-name">{{ (item.part as any).filename || '文件' }}</span>
        </a>
      </div>
    </template>

    <!-- Tool file attachments: surfaced from inside collapsed steps -->
    <div v-if="toolAttachments.length > 0" class="tool-attachments-section">
      <div
        v-for="att in toolAttachments"
        :key="att.id"
        class="attachment-item"
      >
        <File :size="16" class="attachment-icon" />
        <span class="attachment-name">{{ att.filename || '未命名文件' }}</span>
        <span v-if="(att as any).size" class="attachment-size">{{ formatSize((att as any).size) }}</span>
        <button class="download-btn" @click="downloadAttachment(att)">
          <FileDown :size="13" /><span>下载</span>
        </button>
      </div>
    </div>

    <!-- Preview file tools: surfaced from inside collapsed steps -->
    <div v-if="previewTools.length > 0" class="preview-tools-section">
      <div
        v-for="(meta, idx) in previewTools"
        :key="meta.path"
        class="preview-item"
      >
        <Eye :size="16" class="preview-icon" />
        <span class="preview-name">{{ meta.filename || '文件预览' }}</span>
        <span v-if="meta.size" class="preview-size">{{ formatSize(meta.size) }}</span>
        <button
          class="preview-btn"
          @click="openPreview(meta, idx)"
          :disabled="openingPreviewIdx === idx"
        >
          <template v-if="openingPreviewIdx === idx">
            <div class="mini-spinner"></div><span>加载中</span>
          </template>
          <template v-else>
            <Eye :size="13" /><span>预览</span>
          </template>
        </button>
      </div>
    </div>
  </div>

  <!-- Image preview -->
  <Teleport to="body">
    <div v-if="previewImageUrl" class="image-preview-overlay" @click="previewImageUrl = null">
      <img :src="previewImageUrl" class="preview-image" @click.stop />
      <button class="preview-close" @click="previewImageUrl = null"><X :size="24" /></button>
    </div>
  </Teleport>
</template>

<style scoped>
.agent-group {
  width: 100%;
}

/* Prose / Markdown styling lives in global style.css (.markdown-content) */
.markdown-content {
  margin-bottom: 4px;
}

.file-attachment { margin: 8px 0; }

.uploaded-image {
  max-width: 100%; max-height: 300px;
  border-radius: var(--radius-md); cursor: pointer;
  transition: transform var(--transition-fast);
  border: 1px solid var(--border-subtle);
}
.uploaded-image:hover { transform: scale(1.01); }

.file-badge {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 12px; background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md); font-size: var(--text-13);
  text-decoration: none; color: inherit; cursor: pointer;
  transition: background var(--transition-fast);
}
.file-badge:hover { background: var(--bg-elevated); }
.file-icon { font-size: var(--text-lg); }
.file-name {
  color: var(--text-primary); max-width: 200px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* Tool file attachments surfaced from steps */
.tool-attachments-section,
.preview-tools-section {
  margin-top: 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.attachment-item,
.preview-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
}

.attachment-item:not(:last-child),
.preview-item:not(:last-child) {
  border-bottom: 1px solid var(--border-subtle);
}

.attachment-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.preview-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.attachment-name,
.preview-name {
  flex: 1;
  font-size: var(--text-13);
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-size,
.preview-size {
  font-size: var(--text-sm);
  color: var(--text-muted);
  flex-shrink: 0;
}

.download-btn,
.preview-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--accent);
  color: var(--accent-fg);
  border: none;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
  flex-shrink: 0;
}

.download-btn:hover,
.preview-btn:hover:not(:disabled) {
  background: var(--accent-hover);
  transform: translateY(-1px);
}

.download-btn:active,
.preview-btn:active:not(:disabled) {
  transform: translateY(0);
}

.preview-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.mini-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

</style>
