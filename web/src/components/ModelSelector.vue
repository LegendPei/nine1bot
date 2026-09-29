<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Search, Check, Star } from 'lucide-vue-next'
import type { Provider } from '../api/client'

const props = defineProps<{
  providers: Provider[]
  currentProvider: string
  currentModel: string
  defaultProvider: string
  defaultModel: string
  loading: boolean
}>()
const emit = defineEmits<{
  select: [providerId: string, modelId: string]
  'set-default': [providerId: string, modelId: string]
  'manage-providers': []
}>()
const query = ref('')
const limit = ref(50)
watch(query, () => { limit.value = 50 })
const matches = computed(() => {
  const term = query.value.trim().toLowerCase()
  return props.providers.filter(provider => provider.authenticated).flatMap(provider =>
    provider.models.filter(model => `${provider.name} ${model.name} ${model.id}`.toLowerCase().includes(term))
      .map(model => ({ provider, model })),
  )
})
const visible = computed(() => matches.value.slice(0, limit.value))
const currentName = computed(() => props.providers.find(p => p.id === props.currentProvider)?.models.find(m => m.id === props.currentModel)?.name || props.currentModel || '未选择')
const defaultName = computed(() => props.providers.find(p => p.id === props.defaultProvider)?.models.find(m => m.id === props.defaultModel)?.name || props.defaultModel || '未设置')
function isDefault(providerId: string, modelId: string) { return props.defaultProvider === providerId && props.defaultModel === modelId }
</script>

<template>
  <section class="model-selector">
    <div class="section-header">
      <div><h3>选择模型</h3><p>当前选择用于接下来发送的消息，全局默认写入 Nine1Bot 配置。</p></div>
      <button class="btn btn-sm btn-ghost" @click="emit('manage-providers')">管理供应商</button>
    </div>
    <div class="model-summary">
      <div><span>当前选择</span><strong>{{ currentName }}</strong></div>
      <div><span>全局默认</span><strong>{{ defaultName }}</strong></div>
    </div>
    <label class="model-search"><Search :size="16" /><input v-model="query" placeholder="搜索模型或供应商" aria-label="搜索模型或供应商" /></label>
    <div v-if="loading" class="model-loading" role="status">正在更新模型列表…</div>
    <div class="models-list">
      <div v-for="{ provider, model } in visible" :key="`${provider.id}/${model.id}`" class="model-card" :class="{ active: currentProvider === provider.id && currentModel === model.id }">
        <button class="model-pick" :aria-pressed="currentProvider === provider.id && currentModel === model.id" @click="emit('select', provider.id, model.id)">
          <span class="model-check"><Check v-if="currentProvider === provider.id && currentModel === model.id" :size="14" /></span>
          <span class="model-info"><strong>{{ model.name || model.id }}</strong><small>{{ provider.name }}<template v-if="model.contextWindow"> · {{ (model.contextWindow / 1000).toFixed(0) }}K 上下文</template></small></span>
        </button>
        <button class="default-model-btn" :class="{ selected: isDefault(provider.id, model.id) }" :disabled="isDefault(provider.id, model.id)" :title="isDefault(provider.id, model.id) ? '全局默认模型' : '设为全局默认'" @click="emit('set-default', provider.id, model.id)"><Star :size="14" :fill="isDefault(provider.id, model.id) ? 'currentColor' : 'none'" /><span>{{ isDefault(provider.id, model.id) ? '默认' : '设为默认' }}</span></button>
      </div>
    </div>
    <button v-if="matches.length > limit" class="btn btn-ghost btn-sm" @click="limit += 50">显示更多（{{ visible.length }} / {{ matches.length }}）</button>
    <div v-if="!loading && !matches.length" class="model-empty">
      <p>{{ query ? '没有找到匹配的模型' : '连接供应商后即可选择模型' }}</p>
      <button v-if="!query" class="btn btn-primary btn-sm" @click="emit('manage-providers')">连接供应商</button>
    </div>
  </section>
</template>

<style scoped>
.model-selector { display: flex; flex-direction: column; gap: 18px; }
.section-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
h3 { font-size: 17px; font-weight: 600; margin: 0 0 6px; }
.section-header p { font-size: 12px; color: var(--text-muted); line-height: 1.6; max-width: 380px; }
.model-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.model-summary > div { padding: 14px 16px; border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--bg-secondary); display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.model-summary span { font-size: 12px; color: var(--text-muted); }
.model-summary strong { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.model-search { display: flex; align-items: center; gap: 10px; border: 1px solid var(--border-default); border-radius: 8px; padding: 10px 12px; color: var(--text-muted); }
.model-search input { border: 0; outline: none; background: transparent; flex: 1; min-width: 0; color: var(--text-primary); font: inherit; font-size: 13px; }
.model-search:focus-within { border-color: var(--accent); }
.models-list { display: flex; flex-direction: column; gap: 6px; }
.model-card { display: flex; align-items: center; border: 1px solid var(--border-subtle); border-radius: 9px; background: var(--bg-elevated); }
.model-card.active { border-color: var(--accent); background: var(--accent-subtle); }
.model-pick { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; border: 0; padding: 14px; text-align: left; background: transparent; color: var(--text-primary); cursor: pointer; }
.model-check { display: flex; align-items: center; justify-content: center; width: 18px; height: 18px; border: 1px solid var(--border-default); border-radius: 50%; flex-shrink: 0; color: var(--accent); }
.model-card.active .model-check { border-color: var(--accent); }
.model-info { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.model-info strong { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.model-info small { color: var(--text-muted); font-size: 11px; }
.default-model-btn { display: flex; align-items: center; gap: 5px; background: transparent; border: 0; padding: 12px; color: var(--text-muted); cursor: pointer; font-size: 11px; flex-shrink: 0; }
.default-model-btn.selected { color: var(--accent); cursor: default; }
.model-empty { text-align: center; padding: 32px 16px; color: var(--text-muted); }
.model-empty p { margin-bottom: 16px; }
.model-loading { font-size: 12px; color: var(--text-muted); }
@media (max-width: 640px) { .section-header { flex-direction: column; } .default-model-btn span { display: none; } .model-summary { gap: 8px; } }
</style>
