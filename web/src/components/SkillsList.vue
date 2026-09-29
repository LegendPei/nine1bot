<script setup lang="ts">
import { computed, ref } from 'vue'
import { Search, X } from 'lucide-vue-next'
import type { Skill } from '../api/client'

const props = defineProps<{
  skills: Skill[]
  loading: boolean
}>()

const searchQuery = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const filteredSkills = computed(() => {
  const terms = searchQuery.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return props.skills.filter(skill => {
    const text = `${skill.name} ${skill.description || ''}`.toLocaleLowerCase()
    return terms.every(term => text.includes(term))
  })
})

function clearSearch() {
  searchQuery.value = ''
  searchInput.value?.focus()
}
</script>

<template>
  <div class="skills-list">
    <div class="section-header">
      <h3 class="section-title">可用技能</h3>
      <p class="section-desc text-muted text-sm">AI 可以使用的内置和插件技能</p>
      <div class="skill-hint">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <path d="M12 16v-4M12 8h.01"/>
        </svg>
        <span>需要安装网上的技能？在聊天中发送技能链接，让 Nine1Bot 帮你安装</span>
      </div>
    </div>

    <div class="skill-search-toolbar">
      <div class="skill-search">
        <Search :size="16" aria-hidden="true" />
        <input
          ref="searchInput"
          v-model="searchQuery"
          type="search"
          aria-label="搜索可用技能"
          placeholder="搜索技能名称或描述…"
        />
        <button v-if="searchQuery" class="btn btn-ghost btn-icon" aria-label="清空技能搜索" title="清空搜索" @click="clearSearch">
          <X :size="16" />
        </button>
      </div>
      <p v-if="!loading" class="skill-search-count text-muted text-sm" role="status">
        {{ searchQuery.trim() ? `找到 ${filteredSkills.length} 个技能，共 ${skills.length} 个` : `共 ${skills.length} 个技能` }}
      </p>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="loading-spinner"></div>
      <span class="text-muted">加载中...</span>
    </div>

    <div v-else-if="skills.length === 0" class="empty-state">
      <div class="empty-state-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
        </svg>
      </div>
      <p class="empty-state-title">暂无可用技能</p>
      <p class="empty-state-description">在聊天中发送技能仓库链接，让 Nine1Bot 帮你安装</p>
    </div>

    <div v-else-if="filteredSkills.length === 0" class="empty-state">
      <p class="empty-state-title">没有找到匹配的技能</p>
      <p class="empty-state-description">试试其他名称或描述中的关键词</p>
      <button class="btn btn-ghost" @click="clearSearch">清空搜索</button>
    </div>

    <div v-else class="skills-grid">
      <div v-for="skill in filteredSkills" :key="skill.name" class="skill-card card">
        <div class="card-body">
          <div class="skill-header">
            <div class="skill-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
              </svg>
            </div>
            <span class="badge" :class="skill.source === 'builtin' ? 'badge-info' : 'badge-accent'">
              {{ skill.source === 'builtin' ? '内置' : '插件' }}
            </span>
          </div>
          <div class="skill-name">{{ skill.name }}</div>
          <div v-if="skill.description" class="skill-desc text-sm text-muted">
            {{ skill.description }}
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.skills-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}

.skill-search-toolbar { display: flex; flex-direction: column; gap: var(--space-sm); }
.skill-search { display: flex; align-items: center; gap: var(--space-sm); min-width: 0; padding: 4px 10px; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--bg-primary); }
.skill-search:focus-within { border-color: var(--accent); }
.skill-search > svg { flex-shrink: 0; color: var(--text-muted); }
.skill-search input { width: 100%; min-width: 0; padding: 6px 0; border: 0; outline: 0; background: transparent; color: var(--text-primary); font: inherit; font-size: var(--text-sm); }
.skill-search input::placeholder { color: var(--text-muted); }
.skill-search input::-webkit-search-cancel-button { -webkit-appearance: none; }
.skill-search button { flex-shrink: 0; }
.skill-search-count { margin: 0; }

.section-header {
  margin-bottom: var(--space-sm);
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: var(--space-xs);
}

.section-desc {
  margin: 0;
}

.skill-hint {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-top: var(--space-md);
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  font-size: 0.875rem;
  color: var(--text-secondary);
}

.skill-hint svg {
  flex-shrink: 0;
  color: var(--accent);
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  padding: var(--space-xl);
}

.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(200px, 100%), 1fr));
  gap: var(--space-md);
}

.skill-card .card-body {
  padding: var(--space-md);
}

.skill-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-sm);
}

.skill-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
  color: var(--text-muted);
}

.skill-name {
  overflow-wrap: anywhere;
  font-weight: 500;
  margin-bottom: var(--space-xs);
}

.skill-desc {
  overflow-wrap: anywhere;
  line-height: 1.4;
}
</style>
