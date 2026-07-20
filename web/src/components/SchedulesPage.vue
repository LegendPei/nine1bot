<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Copy,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
} from 'lucide-vue-next'
import {
  mcpApi,
  projectApi,
  providerApi,
  scheduleApi,
  type McpServer,
  type Provider,
  type ScheduleRun,
  type ScheduleRule,
  type ScheduleTask,
  type ScheduleTaskInput,
  type Session,
} from '../api/client'
import { copyText as copyToClipboard } from '../utils/clipboard'
import type { ProjectInfo } from './Sidebar.vue'

const props = defineProps<{
  projects: ProjectInfo[]
}>()

const emit = defineEmits<{
  selectSession: [session: Session]
}>()

const DEFAULT_PROMPT = [
  'Scheduled task {{task.name}} triggered an automated Nine1Bot run.',
  '',
  'Project: {{project.name}}',
  'Scheduled at: {{schedule.scheduledAt}}',
  'Triggered at: {{schedule.triggeredAt}}',
  '',
  'Please execute the configured recurring task using the project context and stay within the configured permissions.',
].join('\n')

const TIMEZONE_FALLBACKS = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
]

type RuleType = ScheduleRule['type']

const tasks = ref<ScheduleTask[]>([])
const runs = ref<ScheduleRun[]>([])
const providers = ref<Provider[]>([])
const mcpServers = ref<McpServer[]>([])
const selectedTaskId = ref('')
const selectedRunId = ref('')
const showCreateForm = ref(false)
const showMcpPicker = ref(false)
const pendingMcpServers = ref<string[]>([])
const fullPermissionConfirmed = ref(false)
const isLoading = ref(false)
const isSaving = ref(false)
const isRunning = ref(false)
const error = ref('')
const notice = ref('')
const pollingTimer = ref<ReturnType<typeof setInterval> | null>(null)
const form = ref(defaultForm())

const timezoneOptions = computed(() => {
  const supported = (Intl as any).supportedValuesOf?.('timeZone') as string[] | undefined
  const current = form.value.timezone || browserTimezone()
  return [...new Set([current, ...(supported?.length ? supported : TIMEZONE_FALLBACKS)])]
})
const sortedProjects = computed(() => props.projects.slice().sort((a, b) => b.time.updated - a.time.updated))
const selectedTask = computed(() => tasks.value.find((task) => task.id === selectedTaskId.value) || null)
const selectedRuns = computed(() => {
  if (!selectedTaskId.value) return runs.value
  return runs.value.filter((run) => run.taskID === selectedTaskId.value)
})
const selectedRun = computed(() => selectedRuns.value.find((run) => run.id === selectedRunId.value) || null)
const selectedProvider = computed(() => providers.value.find((provider) => provider.id === form.value.modelProviderID))
const selectedProviderModels = computed(() => selectedProvider.value?.models || [])
const defaultMcpServers = computed(() => mcpServers.value.filter((server) => server.status !== 'disabled').map((server) => server.name))
const addedMcpServers = computed(() => form.value.mcpServers.filter((server) => server.trim()))
const availableMcpServers = computed(() => mcpServers.value.filter((server) => server.status !== 'disabled'))
const effectiveMcpServers = computed(() => {
  if (form.value.resourcesMode === 'default') return defaultMcpServers.value
  return [...new Set([...defaultMcpServers.value, ...addedMcpServers.value])]
})
const enabledCount = computed(() => tasks.value.filter((task) => task.enabled).length)
const activeRunCount = computed(() => runs.value.filter((run) => run.status === 'accepted' || run.status === 'running').length)

function browserTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function defaultForm() {
  return {
    name: '',
    enabled: true,
    projectID: '',
    ruleType: 'daily' as RuleType,
    onceAmount: 1,
    onceUnit: 'hour' as 'hour' | 'day',
    dailyTime: '09:00',
    intervalEvery: 24,
    intervalUnit: 'hour' as 'hour' | 'day',
    timezone: browserTimezone(),
    promptTemplate: DEFAULT_PROMPT,
    modelMode: 'default' as 'default' | 'custom',
    modelProviderID: '',
    modelID: '',
    resourcesMode: 'default' as 'default' | 'default-plus-selected',
    mcpServers: [] as string[],
    permissionMode: 'default' as 'default' | 'full',
  }
}

function projectLabel(projectID: string) {
  const project = props.projects.find((item) => item.id === projectID)
  return project?.name || project?.rootDirectory || project?.worktree || projectID
}

function resetCreateForm() {
  const next = defaultForm()
  next.projectID = sortedProjects.value[0]?.id || ''
  next.modelProviderID = providers.value[0]?.id || ''
  next.modelID = providers.value[0]?.models[0]?.id || ''
  form.value = next
  selectedRunId.value = ''
  fullPermissionConfirmed.value = false
}

function loadFormFromTask(task: ScheduleTask | null) {
  if (!task) {
    resetCreateForm()
    return
  }
  const model = task.runtimeProfile.model
  form.value = {
    ...defaultForm(),
    name: task.name,
    enabled: task.enabled,
    projectID: task.projectID,
    ruleType: task.schedule.type,
    onceAmount: task.schedule.type === 'once-after' ? Math.max(1, Math.round(task.schedule.delayMs / 3_600_000)) : 1,
    onceUnit: 'hour',
    dailyTime: task.schedule.type === 'daily' ? task.schedule.timeOfDay : '09:00',
    intervalEvery: task.schedule.type === 'interval' ? task.schedule.every : 24,
    intervalUnit: task.schedule.type === 'interval' ? task.schedule.unit : 'hour',
    timezone: task.timezone || browserTimezone(),
    promptTemplate: task.promptTemplate || DEFAULT_PROMPT,
    modelMode: task.runtimeProfile.modelMode,
    modelProviderID: model?.providerID || providers.value[0]?.id || '',
    modelID: model?.modelID || providers.value[0]?.models[0]?.id || '',
    resourcesMode: task.runtimeProfile.resourcesMode,
    mcpServers: [...(task.runtimeProfile.mcpServers || [])],
    permissionMode: task.permissionPolicy.mode,
  }
  fullPermissionConfirmed.value = task.permissionPolicy.mode === 'full'
}

watch(
  () => props.projects,
  () => {
    if (!form.value.projectID && sortedProjects.value[0]) {
      form.value.projectID = sortedProjects.value[0].id
    }
  },
  { immediate: true },
)

watch(selectedProviderModels, (models) => {
  if (form.value.modelMode === 'custom' && models.length > 0 && !models.some((model) => model.id === form.value.modelID)) {
    form.value.modelID = models[0].id
  }
})

watch(
  () => form.value.resourcesMode,
  (mode) => {
    if (mode === 'default') form.value.mcpServers = []
  },
)

async function loadAll() {
  isLoading.value = true
  error.value = ''
  try {
    const previousTaskId = selectedTaskId.value
    const [nextTasks, nextRuns, providerResult, nextMcpServers] = await Promise.all([
      scheduleApi.tasks(),
      scheduleApi.runs({ limit: 100 }),
      providerApi.list(),
      mcpApi.list(),
    ])
    tasks.value = nextTasks
    runs.value = nextRuns
    providers.value = providerResult.providers
    mcpServers.value = nextMcpServers
    if (selectedTaskId.value && !nextTasks.some((task) => task.id === selectedTaskId.value)) {
      selectedTaskId.value = nextTasks[0]?.id || ''
    } else if (!selectedTaskId.value && nextTasks[0]) {
      selectedTaskId.value = nextTasks[0].id
    }
    if (!showCreateForm.value && selectedTaskId.value !== previousTaskId) {
      loadFormFromTask(selectedTask.value)
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    isLoading.value = false
  }
}

async function refreshRuns() {
  runs.value = await scheduleApi.runs({ limit: 100 })
}

async function refreshTasksAndRuns() {
  const [nextTasks, nextRuns] = await Promise.all([
    scheduleApi.tasks(),
    scheduleApi.runs({ limit: 100 }),
  ])
  tasks.value = nextTasks
  runs.value = nextRuns
}

function scheduleFromForm(): ScheduleRule {
  if (form.value.ruleType === 'once-after') {
    const multiplier = form.value.onceUnit === 'day' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000
    return {
      type: 'once-after',
      delayMs: Math.max(1, form.value.onceAmount) * multiplier,
    }
  }
  if (form.value.ruleType === 'interval') {
    return {
      type: 'interval',
      every: Math.max(1, form.value.intervalEvery),
      unit: form.value.intervalUnit,
    }
  }
  return {
    type: 'daily',
    timeOfDay: form.value.dailyTime,
  }
}

function taskInput(): ScheduleTaskInput {
  if (!form.value.name.trim()) throw new Error('请填写名称')
  if (!form.value.projectID) throw new Error('请选择项目')
  if (form.value.modelMode === 'custom' && (!form.value.modelProviderID || !form.value.modelID)) {
    throw new Error('自定义模型模式下请选择服务商和模型')
  }
  if (form.value.permissionMode === 'full' && !fullPermissionConfirmed.value) {
    throw new Error('保存前请确认完全权限模式')
  }
  return {
    name: form.value.name.trim(),
    enabled: form.value.enabled,
    projectID: form.value.projectID,
    schedule: scheduleFromForm(),
    timezone: form.value.timezone || browserTimezone(),
    promptTemplate: form.value.promptTemplate || DEFAULT_PROMPT,
    runtimeProfile: {
      modelMode: form.value.modelMode,
      model: form.value.modelMode === 'custom'
        ? { providerID: form.value.modelProviderID, modelID: form.value.modelID }
        : undefined,
      resourcesMode: form.value.resourcesMode,
      mcpServers: form.value.resourcesMode === 'default-plus-selected'
        ? form.value.mcpServers.filter((server) => server.trim())
        : [],
    },
    permissionPolicy: {
      mode: form.value.permissionMode,
    },
    overlapPolicy: 'skip',
    misfirePolicy: { mode: 'skip' },
  }
}

async function saveTask() {
  isSaving.value = true
  error.value = ''
  notice.value = ''
  try {
    const payload = taskInput()
    if (showCreateForm.value) {
      const created = await scheduleApi.createTask(payload)
      tasks.value = await scheduleApi.tasks()
      selectedTaskId.value = created.id
      showCreateForm.value = false
      loadFormFromTask(created)
      notice.value = '定时任务已创建。'
    } else if (selectedTask.value) {
      const updated = await scheduleApi.updateTask(selectedTask.value.id, payload)
      tasks.value = tasks.value.map((task) => task.id === updated.id ? updated : task)
      loadFormFromTask(updated)
      notice.value = '定时任务已保存。'
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    isSaving.value = false
  }
}

async function deleteTask() {
  if (!selectedTask.value) return
  const ok = confirm(`确定要删除定时任务 "${selectedTask.value.name}" 吗？`)
  if (!ok) return
  isSaving.value = true
  error.value = ''
  notice.value = ''
  try {
    await scheduleApi.deleteTask(selectedTask.value.id)
    tasks.value = await scheduleApi.tasks()
    selectedTaskId.value = tasks.value[0]?.id || ''
    selectedRunId.value = ''
    loadFormFromTask(selectedTask.value)
    notice.value = '定时任务已删除。'
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    isSaving.value = false
  }
}

async function runTaskNow() {
  if (!selectedTask.value) return
  isRunning.value = true
  error.value = ''
  notice.value = ''
  try {
    const result = await scheduleApi.runTask(selectedTask.value.id)
    await refreshTasksAndRuns()
    selectedRunId.value = result.run.id
    notice.value = result.accepted ? '定时任务已开始运行。' : (result.error || '本次运行已跳过。')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    isRunning.value = false
  }
}

async function openRunSession(run: ScheduleRun) {
  if (!run.sessionID) return
  error.value = ''
  try {
    const sessions = await projectApi.sessions(run.projectID, { roots: true, limit: 300 })
    const session = sessions.find((item) => item.id === run.sessionID)
    if (!session) throw new Error('会话已不存在')
    emit('selectSession', session)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function copyText(text: string) {
  if (!text) return
  error.value = ''
  notice.value = ''
  try {
    if (!await copyToClipboard(text)) throw new Error('copy failed')
    notice.value = '已复制。'
  } catch {
    error.value = '自动复制失败，请手动复制。'
  }
}

function beginCreate() {
  showCreateForm.value = true
  selectedTaskId.value = ''
  selectedRunId.value = ''
  showMcpPicker.value = false
  resetCreateForm()
}

function selectTask(task: ScheduleTask) {
  const changed = showCreateForm.value || selectedTaskId.value !== task.id
  showCreateForm.value = false
  selectedTaskId.value = task.id
  selectedRunId.value = ''
  showMcpPicker.value = false
  if (changed) loadFormFromTask(task)
}

function selectRun(run: ScheduleRun) {
  selectedRunId.value = selectedRunId.value === run.id ? '' : run.id
}

function openMcpPicker() {
  pendingMcpServers.value = [...form.value.mcpServers]
  showMcpPicker.value = true
}

function applyMcpPicker() {
  form.value.mcpServers = [...new Set(pendingMcpServers.value)]
  form.value.resourcesMode = form.value.mcpServers.length > 0 ? 'default-plus-selected' : 'default'
  showMcpPicker.value = false
}

function removeMcpServer(server: string) {
  form.value.mcpServers = form.value.mcpServers.filter((item) => item !== server)
  if (form.value.mcpServers.length === 0) form.value.resourcesMode = 'default'
}

function handlePermissionModeChange() {
  if (form.value.permissionMode !== 'full') {
    fullPermissionConfirmed.value = false
    return
  }
  const ok = confirm('完全权限模式将自动允许该任务运行时的所有权限请求。')
  if (ok) {
    fullPermissionConfirmed.value = true
  } else {
    form.value.permissionMode = 'default'
    fullPermissionConfirmed.value = false
  }
}

function describeRule(task: ScheduleTask) {
  if (task.schedule.type === 'once-after') {
    const hours = Math.round(task.schedule.delayMs / 3_600_000)
    return `${hours} 小时后执行一次`
  }
  if (task.schedule.type === 'daily') {
    return `每天 ${task.schedule.timeOfDay}`
  }
  const unit = task.schedule.unit === 'hour' ? '小时' : '天'
  return `每 ${task.schedule.every} ${unit}`
}

function latestRunFor(taskID: string) {
  return runs.value.find((run) => run.taskID === taskID)
}

function statusClass(status?: ScheduleRun['status']) {
  if (status === 'succeeded') return 'ok'
  if (status === 'failed') return 'error'
  if (status === 'skipped') return 'warn'
  if (status === 'running' || status === 'accepted') return 'blue'
  return 'muted'
}

function runStatusText(status?: ScheduleRun['status']) {
  if (!status) return '暂无运行'
  switch (status) {
    case 'accepted': return '已接受'
    case 'running': return '运行中'
    case 'succeeded': return '成功'
    case 'failed': return '失败'
    case 'skipped': return '已跳过'
    default: return status
  }
}

function mcpStatusText(status: string) {
  switch (status) {
    case 'connected': return '已连接'
    case 'connecting': return '连接中'
    case 'auth_in_progress': return '认证中'
    case 'disabled': return '已禁用'
    case 'failed': return '连接失败'
    default: return status
  }
}

function runSummary(run: ScheduleRun) {
  return run.error || run.promptPreview || run.reason || '定时运行'
}

function formatDate(value?: number) {
  if (!value) return '从未'
  return new Date(value).toLocaleString()
}

function formatJson(value: unknown) {
  if (value === undefined || value === null) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function renderPreview() {
  const projectName = projectLabel(form.value.projectID)
  return (form.value.promptTemplate || DEFAULT_PROMPT)
    .replace(/{{\s*task\.name\s*}}/g, form.value.name || '定时任务')
    .replace(/{{\s*project\.name\s*}}/g, projectName || '项目')
    .replace(/{{\s*schedule\.scheduledAt\s*}}/g, '2026-01-01T09:00:00.000Z')
    .replace(/{{\s*schedule\.triggeredAt\s*}}/g, '2026-01-01T09:00:02.000Z')
}

onMounted(() => {
  void loadAll()
  pollingTimer.value = setInterval(() => {
    refreshTasksAndRuns().catch(() => undefined)
  }, 5000)
})

onUnmounted(() => {
  if (pollingTimer.value) clearInterval(pollingTimer.value)
})
</script>

<template>
  <div class="schedules-page">
    <header class="schedules-toolbar">
      <div class="metric">
        <CalendarClock :size="16" />
        <span>{{ enabledCount }} 个已启用</span>
      </div>
      <div class="metric">
        <Activity :size="16" />
        <span>{{ activeRunCount }} 个进行中</span>
      </div>
      <div class="toolbar-actions">
        <button class="btn" @click="loadAll" :disabled="isLoading">
          <RefreshCw :size="16" :class="{ spin: isLoading }" />
          刷新
        </button>
        <button class="btn primary" @click="beginCreate">
          <Plus :size="16" />
          新建任务
        </button>
      </div>
    </header>

    <div v-if="error" class="notice error">
      <AlertTriangle :size="16" />
      {{ error }}
    </div>
    <div v-if="notice" class="notice">
      <CheckCircle2 :size="16" />
      {{ notice }}
    </div>

    <section class="schedules-workspace">
      <aside class="tasks-column">
        <div class="column-header">
          <h2>任务</h2>
          <span class="pill blue">共 {{ tasks.length }} 个</span>
        </div>
        <button
          v-for="task in tasks"
          :key="task.id"
          class="task-item"
          :class="{ active: selectedTaskId === task.id }"
          @click="selectTask(task)"
        >
          <span class="task-icon"><Clock :size="16" /></span>
          <span class="task-copy">
            <strong>{{ task.name }}</strong>
            <span>{{ projectLabel(task.projectID) }} · {{ describeRule(task) }}</span>
          </span>
          <span class="task-badges">
            <span class="pill" :class="task.enabled ? 'ok' : 'muted'">{{ task.enabled ? '已启用' : '已禁用' }}</span>
            <span class="pill" :class="statusClass(latestRunFor(task.id)?.status)">{{ runStatusText(latestRunFor(task.id)?.status) }}</span>
          </span>
        </button>
        <div v-if="tasks.length === 0" class="empty-note">
          暂无定时任务。
        </div>
      </aside>

      <main class="detail-column">
        <div class="detail-header">
          <div>
            <h2>{{ showCreateForm ? '新建定时任务' : selectedTask?.name || '定时任务' }}</h2>
            <p>{{ showCreateForm ? '创建绑定到项目的周期性执行入口。' : projectLabel(selectedTask?.projectID || '') }}</p>
          </div>
          <div v-if="selectedTask && !showCreateForm" class="detail-actions">
            <button class="btn" @click="runTaskNow" :disabled="isSaving || isRunning">
              <Play :size="16" />
              立即运行
            </button>
            <button class="btn danger" @click="deleteTask" :disabled="isSaving || isRunning">
              <Trash2 :size="16" />
              删除
            </button>
          </div>
        </div>

        <div class="detail-grid">
          <section class="panel wide">
            <h3>任务</h3>
            <div class="form-grid two">
              <label>
                <span>名称</span>
                <input v-model="form.name" placeholder="每日项目检查" />
              </label>
              <label>
                <span>项目</span>
                <select v-model="form.projectID">
                  <option v-for="project in sortedProjects" :key="project.id" :value="project.id">
                    {{ projectLabel(project.id) }}
                  </option>
                </select>
              </label>
            </div>
            <label class="toggle-row">
              <input v-model="form.enabled" type="checkbox" />
              <span>已启用</span>
            </label>
          </section>

          <section class="panel wide">
            <h3>执行计划</h3>
            <div class="segmented">
              <label><input v-model="form.ruleType" type="radio" value="once-after" /> 延时一次</label>
              <label><input v-model="form.ruleType" type="radio" value="daily" /> 每天</label>
              <label><input v-model="form.ruleType" type="radio" value="interval" /> 间隔</label>
            </div>
            <div class="form-grid two">
              <template v-if="form.ruleType === 'once-after'">
                <label>
                  <span>延迟</span>
                  <input v-model.number="form.onceAmount" type="number" min="1" />
                </label>
                <label>
                  <span>单位</span>
                  <select v-model="form.onceUnit">
                    <option value="hour">小时</option>
                    <option value="day">天</option>
                  </select>
                </label>
              </template>
              <template v-else-if="form.ruleType === 'daily'">
                <label>
                  <span>时间</span>
                  <input v-model="form.dailyTime" type="time" />
                </label>
                <label>
                  <span>时区</span>
                  <select v-model="form.timezone">
                    <option v-for="timezone in timezoneOptions" :key="timezone" :value="timezone">
                      {{ timezone }}
                    </option>
                  </select>
                </label>
              </template>
              <template v-else>
                <label>
                  <span>每隔</span>
                  <input v-model.number="form.intervalEvery" type="number" min="1" />
                </label>
                <label>
                  <span>单位</span>
                  <select v-model="form.intervalUnit">
                    <option value="hour">小时</option>
                    <option value="day">天</option>
                  </select>
                </label>
              </template>
            </div>
            <div v-if="selectedTask && !showCreateForm" class="schedule-meta">
              <span>下次：{{ formatDate(selectedTask.nextRunAt) }}</span>
              <span>上次：{{ formatDate(selectedTask.lastRunAt) }}</span>
            </div>
          </section>

          <section class="panel wide">
            <h3>运行时</h3>
            <div class="form-grid two">
              <label>
                <span>权限</span>
                <select v-model="form.permissionMode" @change="handlePermissionModeChange">
                  <option value="default">默认</option>
                  <option value="full">完全权限</option>
                </select>
              </label>
              <label>
                <span>模型</span>
                <select v-model="form.modelMode">
                  <option value="default">默认模型</option>
                  <option value="custom">自定义模型</option>
                </select>
              </label>
            </div>
            <div v-if="form.modelMode === 'custom'" class="form-grid two">
              <label>
                <span>服务商</span>
                <select v-model="form.modelProviderID">
                  <option v-for="provider in providers" :key="provider.id" :value="provider.id">
                    {{ provider.name || provider.id }}
                  </option>
                </select>
              </label>
              <label>
                <span>模型</span>
                <select v-model="form.modelID">
                  <option v-for="model in selectedProviderModels" :key="model.id" :value="model.id">
                    {{ model.name || model.id }}
                  </option>
                </select>
              </label>
            </div>
            <div class="mcp-row">
              <div>
                <strong>MCP 资源</strong>
                <p>{{ form.resourcesMode === 'default' ? '默认 MCP 配置' : '默认 MCP 加所选服务器' }}</p>
              </div>
              <button class="btn" @click="openMcpPicker" type="button">
                <Settings2 :size="16" />
                选择 MCP
              </button>
            </div>
            <div class="chips">
              <span v-for="server in effectiveMcpServers" :key="server" class="chip">
                {{ server }}
                <button v-if="addedMcpServers.includes(server)" @click="removeMcpServer(server)" type="button">×</button>
              </span>
              <span v-if="effectiveMcpServers.length === 0" class="muted-text">暂无活跃的 MCP 服务器。</span>
            </div>
            <div v-if="showMcpPicker" class="picker-panel">
              <label v-for="server in availableMcpServers" :key="server.name" class="checkbox-row">
                <input v-model="pendingMcpServers" type="checkbox" :value="server.name" />
                <span>{{ server.name }}</span>
                <small>{{ mcpStatusText(server.status) }}</small>
              </label>
              <div class="form-actions">
                <button class="btn" @click="showMcpPicker = false" type="button">取消</button>
                <button class="btn primary" @click="applyMcpPicker" type="button">应用</button>
              </div>
            </div>
          </section>

          <section class="panel wide">
            <h3>提示词</h3>
            <textarea v-model="form.promptTemplate" rows="9" />
            <div class="preview-box">
              <span>预览</span>
              <pre>{{ renderPreview() }}</pre>
            </div>
          </section>

          <section class="panel wide">
            <div class="form-actions">
              <button class="btn primary" @click="saveTask" :disabled="isSaving">
                <Save :size="16" />
                {{ showCreateForm ? '创建任务' : '保存任务' }}
              </button>
            </div>
          </section>

          <section class="panel wide runs-panel">
            <div class="runs-heading">
              <h3>运行记录</h3>
              <button class="btn" @click="refreshRuns">
                <RefreshCw :size="16" />
                刷新
              </button>
            </div>
            <button
              v-for="run in selectedRuns"
              :key="run.id"
              class="run-item"
              :class="{ active: selectedRunId === run.id }"
              @click="selectRun(run)"
            >
              <span class="pill" :class="statusClass(run.status)">{{ runStatusText(run.status) }}</span>
              <span>{{ formatDate(run.time.created) }}</span>
              <span>{{ run.reason || '运行' }}</span>
              <strong>{{ runSummary(run) }}</strong>
            </button>
            <div v-if="selectedRuns.length === 0" class="empty-note">暂无运行记录。</div>
            <div v-if="selectedRun" class="run-detail">
              <div class="run-detail-actions">
                <button class="btn" @click="copyText(selectedRun.id)">
                  <Copy :size="16" />
                  复制 ID
                </button>
                <button class="btn" @click="openRunSession(selectedRun)" :disabled="!selectedRun.sessionID">
                  <Activity :size="16" />
                  打开会话
                </button>
              </div>
              <dl>
                <dt>计划时间</dt><dd>{{ formatDate(selectedRun.scheduledAt) }}</dd>
                <dt>触发时间</dt><dd>{{ formatDate(selectedRun.triggeredAt) }}</dd>
                <dt>开始时间</dt><dd>{{ formatDate(selectedRun.time.started) }}</dd>
                <dt>结束时间</dt><dd>{{ formatDate(selectedRun.time.finished) }}</dd>
                <dt>会话</dt><dd>{{ selectedRun.sessionID || '无' }}</dd>
                <dt>轮次</dt><dd>{{ selectedRun.turnSnapshotId || '无' }}</dd>
              </dl>
              <div v-if="selectedRun.error" class="error-box">{{ selectedRun.error }}</div>
              <div v-if="selectedRun.promptPreview" class="preview-box">
                <span>提示词预览</span>
                <pre>{{ selectedRun.promptPreview }}</pre>
              </div>
              <div v-if="selectedRun.responseBody" class="preview-box">
                <span>控制器响应</span>
                <pre>{{ formatJson(selectedRun.responseBody) }}</pre>
              </div>
            </div>
          </section>
        </div>
      </main>
    </section>
  </div>
</template>

<style scoped>
.schedules-page {
  display: grid;
  gap: var(--space-lg);
}

.schedules-toolbar,
.toolbar-actions,
.metric,
.detail-header,
.detail-actions,
.form-actions,
.runs-heading,
.run-detail-actions,
.chips,
.segmented,
.mcp-row {
  display: flex;
  align-items: center;
}

.schedules-toolbar {
  justify-content: space-between;
  gap: var(--space-md);
  flex-wrap: wrap;
}

.metric {
  gap: var(--space-xs);
  color: var(--text-secondary);
  font-size: var(--text-13);
  font-weight: 600;
}

.toolbar-actions,
.detail-actions,
.form-actions,
.run-detail-actions,
.segmented {
  gap: var(--space-sm);
}

.btn {
  height: 36px;
  padding: 0 var(--space-md);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  cursor: pointer;
  font-size: var(--text-13);
  font-weight: 500;
}

.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-fg);
}

.btn.danger,
.notice.error {
  color: var(--error);
}

.btn:hover:not(:disabled) {
  background: var(--bg-tertiary);
  border-color: var(--border-hover);
}

.btn.primary:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.notice {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  color: var(--success);
}

.schedules-workspace {
  display: grid;
  grid-template-columns: 330px minmax(0, 1fr);
  gap: var(--space-lg);
  align-items: start;
  min-height: 620px;
}

.tasks-column,
.detail-column,
.panel {
  min-width: 0;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}

.tasks-column,
.detail-column {
  overflow: hidden;
}

.column-header,
.detail-header,
.panel {
  padding: var(--space-md);
}

.column-header,
.detail-header,
.runs-heading {
  justify-content: space-between;
  gap: var(--space-md);
}

.column-header {
  border-bottom: 1px solid var(--border-default);
}

.column-header h2,
.detail-header h2,
.panel h3,
.runs-heading h3 {
  margin: 0;
  font-weight: 650;
  line-height: 1.2;
}

.column-header h2,
.panel h3,
.runs-heading h3 {
  font-size: var(--text-md);
}

.detail-header h2 {
  font-size: var(--text-2xl);
}

.detail-header p,
.mcp-row p,
.muted-text {
  margin: 2px 0 0;
  color: var(--text-muted);
  font-size: var(--text-13);
}

.task-item {
  width: calc(100% - var(--space-md) * 2);
  margin: var(--space-xs) var(--space-md);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: var(--space-sm);
  align-items: center;
  padding: var(--space-sm);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.task-item.active,
.run-item.active {
  background: var(--bg-secondary);
  border-color: var(--border-default);
}

.task-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  display: grid;
  place-items: center;
  color: var(--accent);
  background: var(--accent-subtle);
}

.task-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.task-copy strong,
.task-copy span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-copy span {
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.task-badges {
  display: grid;
  justify-items: end;
  gap: 4px;
}

.pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 22px;
  padding: 0 8px;
  border-radius: var(--radius-full);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: 650;
  white-space: nowrap;
}

.pill.ok {
  color: var(--success);
  background: var(--success-subtle);
}

.pill.warn {
  color: var(--warning);
  background: var(--warning-subtle);
}

.pill.error {
  color: var(--error);
  background: var(--error-subtle);
}

.pill.blue {
  color: var(--accent);
  background: var(--accent-subtle);
}

.pill.muted {
  color: var(--text-muted);
}

.detail-grid {
  display: grid;
  gap: var(--space-md);
  padding: 0 var(--space-md) var(--space-md);
}

.form-grid {
  display: grid;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
}

.form-grid.two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

label {
  display: grid;
  gap: var(--space-xs);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  font-weight: 650;
}

input,
select,
textarea {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-13);
}

input,
select {
  height: 36px;
  padding: 0 var(--space-sm);
}

textarea {
  resize: vertical;
  padding: var(--space-sm);
  line-height: 1.45;
}

.toggle-row,
.checkbox-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.toggle-row input,
.checkbox-row input {
  width: 16px;
  height: 16px;
}

.segmented {
  flex-wrap: wrap;
  margin-bottom: var(--space-md);
}

.segmented label {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  min-height: 34px;
  padding: 0 var(--space-sm);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  cursor: pointer;
}

.segmented input {
  width: 14px;
  height: 14px;
}

.schedule-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-md);
  color: var(--text-muted);
  font-size: var(--text-13);
}

.mcp-row {
  justify-content: space-between;
  gap: var(--space-md);
  margin-bottom: var(--space-sm);
}

.chips {
  gap: var(--space-xs);
  flex-wrap: wrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  min-height: 24px;
  padding: 0 8px;
  border-radius: var(--radius-full);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: var(--text-sm);
}

.chip button {
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.picker-panel {
  margin-top: var(--space-md);
  display: grid;
  gap: var(--space-sm);
}

.checkbox-row small {
  color: var(--text-muted);
  margin-left: auto;
}

.preview-box {
  display: grid;
  gap: var(--space-xs);
  margin-top: var(--space-md);
}

.preview-box span {
  color: var(--text-muted);
  font-size: var(--text-sm);
  font-weight: 650;
}

pre {
  margin: 0;
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  padding: var(--space-sm);
  border-radius: var(--radius-md);
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.45;
}

.run-item {
  width: 100%;
  display: grid;
  grid-template-columns: auto auto auto minmax(0, 1fr);
  gap: var(--space-sm);
  align-items: center;
  padding: var(--space-sm);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
}

.run-item strong {
  min-width: 0;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.run-detail {
  display: grid;
  gap: var(--space-md);
  margin-top: var(--space-md);
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-default);
}

.run-detail dl {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: var(--space-xs) var(--space-md);
  margin: 0;
}

.run-detail dt {
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.run-detail dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.error-box {
  padding: var(--space-sm);
  border-radius: var(--radius-md);
  background: var(--error-subtle);
  color: var(--error);
  overflow-wrap: anywhere;
}

.empty-note {
  padding: var(--space-md);
  color: var(--text-muted);
  font-size: var(--text-13);
}

.spin {
  animation: spin 1s linear infinite;
}

@media (max-width: 980px) {
  .schedules-workspace,
  .form-grid.two {
    grid-template-columns: 1fr;
  }

  .run-item {
    grid-template-columns: auto minmax(0, 1fr);
  }
}
</style>
