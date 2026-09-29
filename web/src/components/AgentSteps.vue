<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronRight, ChevronDown, Check, X } from 'lucide-vue-next'
import type { MessagePart } from '../api/client'
import ToolCall from './ToolCall.vue'
import { useCollapse } from '../composables/use-collapse'
import { getToolDisplayName } from '../utils/tool-names'
import { summarizeTools } from '../utils/step-summary'

interface Step {
  parts: MessagePart[]
  isComplete: boolean
}

const props = defineProps<{
  steps: Step[]
  isStreaming: boolean
}>()

/* 过程区延迟挂载 + 0fr → 1fr 过渡：收起时不让上百张工具卡常驻 DOM */
const { mounted: bodyMounted, open: isExpanded, toggle } = useCollapse()
const reasoningExpanded = ref<Record<string, boolean>>({})

const allComplete = computed(() => props.steps.length > 0 && props.steps.every(s => s.isComplete))

const allParts = computed(() => props.steps.flatMap(s => s.parts))
const tools = computed(() => allParts.value.filter(part => part.type === 'tool'))
const activeTool = computed(() => tools.value.filter(part => part.state?.status === 'running' || part.state?.status === 'pending').slice(-1)[0])
const runningTool = computed(() => tools.value.filter(part => part.state?.status === 'running').slice(-1)[0])
const failedCount = computed(() => tools.value.filter(part => part.state?.status === 'error').length)
const completedCount = computed(() => tools.value.filter(part => part.state?.status === 'completed').length)

/* 折起时的状态色：失败过就标红，全完成才给绿，其余保持中性。
   原来无条件按 success 着色，没跑完、跑失败了也是一圈绿底。 */
const stepsTone = computed(() => (failedCount.value > 0 ? 'error' : allComplete.value ? 'success' : 'idle'))

const stepSummary = computed(() => {
  const running = runningTool.value
  if (running) {
    const target = getToolTarget(running)
    return target ? `${getToolName(running)} · ${target}` : getToolName(running)
  }
  return summarizeTools(
    tools.value.map(part => ({ label: getToolLabel(part), status: part.state?.status })),
    props.steps.length,
  )
})

/** 运行中折起时也要看得出进度，尤其是中途失败过 */
const peekLabel = computed(() => {
  const done = completedCount.value
  const failed = failedCount.value
  if (failed > 0) return done > 0 ? `已完成 ${done} 次 · ${failed} 次失败` : `${failed} 次失败`
  return done >= 2 ? `已完成 ${done} 次调用` : ''
})

/** 带 target 的人话标题，用于「现在在跑什么」 */
function getToolName(part: MessagePart): string {
  const title = part.state?.title
  if (title) return title
  return getToolLabel(part)
}

/** 归类计数用的名字：不能用 title，title 往回带上了目标文件，一条一类就没法统计 */
function getToolLabel(part: MessagePart): string {
  return getToolDisplayName((part.tool || '').toLowerCase(), part.tool || '工具')
}

function getToolTarget(part: MessagePart): string {
  const input = part.state?.input
  if (!input) return ''
  if (input.filePath || input.file_path) {
    const p = (input.filePath || input.file_path) as string
    return p.length > 45 ? '...' + p.slice(-42) : p
  }
  if (input.path) {
    const p = input.path as string
    return p.length > 45 ? '...' + p.slice(-42) : p
  }
  if (input.command) {
    const cmd = input.command as string
    return cmd.length > 40 ? cmd.slice(0, 40) + '...' : cmd
  }
  if (input.pattern) return `"${input.pattern}"`
  if (input.url) return input.url as string
  if (input.query) return input.query as string
  return ''
}

function toggleReasoning(partId: string) {
  reasoningExpanded.value[partId] = !reasoningExpanded.value[partId]
}

function needsExpandButton(text: string): boolean {
  return text.split('\n').length > 3 || text.length > 200
}
</script>

<template>
  <div class="steps" :class="{ 'is-open': isExpanded }">
    <!-- 运行中且未展开：头让位给当前活跃的工具卡 -->
    <template v-if="isStreaming && !isExpanded">
      <button
        v-if="peekLabel"
        class="steps-peek"
        :class="{ 'has-error': failedCount > 0 }"
        @click="toggle"
      >
        <span>{{ peekLabel }}</span>
        <ChevronRight :size="12" />
      </button>
      <ToolCall v-if="activeTool" :tool="activeTool" :hideAttachments="true" />
      <button v-else class="steps-waiting" @click="toggle">
        <span class="steps-shimmer">正在思考与生成…</span>
        <ChevronRight :size="12" />
      </button>
    </template>

    <!-- 折起与展开共用一个头，身体走高度过渡 -->
    <div
      v-else
      class="steps-head"
      role="button"
      tabindex="0"
      :aria-expanded="isExpanded"
      @click="toggle"
      @keydown.enter.prevent="toggle"
      @keydown.space.prevent="toggle"
    >
      <div class="steps-icon" :class="stepsTone">
        <X v-if="failedCount > 0" :size="10" />
        <Check v-else-if="allComplete" :size="10" />
        <ChevronRight v-else :size="10" />
      </div>
      <span class="steps-summary">{{ stepSummary }}</span>
      <ChevronDown v-if="isExpanded" :size="12" class="steps-chevron" />
      <ChevronRight v-else :size="12" class="steps-chevron" />
    </div>

    <div v-if="bodyMounted" class="steps-collapse" :class="{ open: isExpanded }" :aria-hidden="!isExpanded">
      <div class="steps-body">
        <template v-for="(step, stepIndex) in steps" :key="stepIndex">
          <div v-if="stepIndex > 0" class="step-divider" />
          <template v-for="part in step.parts" :key="part.id">
            <!-- Reasoning block -->
            <div v-if="part.type === 'reasoning'" class="reasoning-block">
              <div v-if="part.text">
                <div
                  class="reasoning-text"
                  :class="{ clamped: !reasoningExpanded[part.id] }"
                >{{ part.text }}</div>
                <button
                  v-if="needsExpandButton(part.text)"
                  class="reasoning-toggle"
                  @click.stop="toggleReasoning(part.id)"
                >
                  {{ reasoningExpanded[part.id] ? '收起' : '展开' }}
                </button>
              </div>
              <div v-else class="loading-wave">
                <span>.</span><span>.</span><span>.</span>
              </div>
            </div>
            <!-- Tool call -->
            <ToolCall v-else-if="part.type === 'tool'" :tool="part" :hideAttachments="true" />
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.steps {
  margin: 2px 0 6px;
}

/* ── 运行中折起时的进度行 ── */
.steps-peek {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  background: transparent;
  border: 0;
  cursor: pointer;
  font-size: var(--text-sm);
  font-family: var(--font-mono);
  color: var(--text-muted);
}
.steps-peek:hover { color: var(--text-secondary); }
.steps-peek.has-error { color: var(--error); }

.steps-waiting {
  display: flex;
  gap: 6px;
  align-items: center;
  background: transparent;
  border: 0;
  padding: 8px 0;
  font-size: var(--text-13);
  color: var(--text-muted);
  cursor: pointer;
}

/* 一道扫过文字的微光，比转圈安静 */
.steps-shimmer {
  background: linear-gradient(
    100deg,
    var(--text-muted) 0%,
    var(--text-muted) 38%,
    var(--text-primary) 50%,
    var(--text-muted) 62%,
    var(--text-muted) 100%
  );
  background-size: 240% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  animation: steps-shimmer 2.2s linear infinite;
}

@keyframes steps-shimmer {
  from { background-position: 130% 0; }
  to { background-position: -30% 0; }
}

/* ── 折起 / 展开共用的头 ── */
.steps-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 4px 6px;
  cursor: pointer;
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  transition: background var(--transition-fast), color var(--transition-fast);
}
.steps-head:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.steps-icon {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background var(--transition-normal), color var(--transition-normal);
}
.steps-icon.success {
  background: color-mix(in srgb, var(--success) 15%, transparent);
  color: var(--success);
}
.steps-icon.error {
  background: var(--error-subtle);
  color: var(--error);
}
.steps-icon.idle {
  background: var(--bg-tertiary);
  color: var(--text-muted);
}

.steps-summary {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
  font-family: var(--font-mono);
  color: var(--text-muted);
}
.steps-head:hover .steps-summary {
  color: var(--text-secondary);
}

.steps-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
}

/* ── 过程正文：0fr → 1fr 让开合有个高度过渡 ── */
.steps-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--transition-normal);
}
.steps-collapse.open {
  grid-template-rows: 1fr;
}
.steps-collapse > * {
  min-height: 0;
  overflow: hidden;
}

/* 这层是 0fr 行轨里的格子项，只能有横向的 padding / border：纵向的压不掉，
   收起时会剩成一条缝（ToolCall.vue 里为此专门垫了一层 .tool-collapse-clip）。 */
.steps-body {
  padding-left: 14px;
  border-left: 1.5px solid var(--border-subtle);
  margin-left: 6px;
}

/* 组里的卡片退成列表行：挂在左侧细轨上表示层级，不再每张一个框。
   展开一次过程就看到十几个圆角方块堆在一起，层级反而更难读。 */
.steps-body :deep(.tool-call) {
  background: transparent;
  border: 0;
  border-radius: 0;
  margin: 0;
}
.steps-body :deep(.tool-call-header) {
  padding: 4px 6px;
  border-radius: var(--radius-sm);
}
.steps-body :deep(.tool-call-header:hover) {
  background: var(--bg-secondary);
}
.steps-body :deep(.tool-call-body) {
  padding: 2px 6px 8px 22px;
  background: transparent;
  border-top: 0;
}

.step-divider {
  height: 1px;
  background: var(--border-subtle);
  margin: 8px 0;
}

/* ── Reasoning ── */
.reasoning-block {
  margin: 4px 0 6px;
}

.reasoning-text {
  font-size: var(--text-sm);
  color: var(--text-muted);
  font-style: italic;
  white-space: pre-wrap;
  line-height: 1.55;
  word-break: break-word;
}

.reasoning-text.clamped {
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.reasoning-toggle {
  font-size: var(--text-xs);
  color: var(--accent);
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;
  margin-top: 2px;
  font-family: inherit;
  line-height: 1.8;
}
.reasoning-toggle:hover {
  text-decoration: underline;
}

/* ── Loading dots ── */
.loading-wave span {
  animation: wave 1.2s infinite ease-in-out;
  display: inline-block;
  margin: 0 1px;
  font-size: var(--text-lg);
  line-height: 10px;
  color: var(--text-muted);
}
.loading-wave span:nth-child(2) { animation-delay: 0.1s; }
.loading-wave span:nth-child(3) { animation-delay: 0.2s; }

@keyframes wave {
  0%, 100% { transform: translateY(0); opacity: 0.5; }
  50% { transform: translateY(-4px); opacity: 1; }
}
</style>
