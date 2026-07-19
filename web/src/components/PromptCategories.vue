<script setup lang="ts">
import { ref } from 'vue'
import { Pencil, BookOpen, Code2, Home, Sparkles, X } from 'lucide-vue-next'

const emit = defineEmits<{
  select: [prompt: string]
}>()

const categories = [
  {
    id: 'write',
    label: '写作',
    icon: Pencil,
    suggestions: [
      '用我最喜欢的历史人物的口吻写一段话',
      '拟一份内容简报',
      '设计一套内容模板',
      '写一段活动介绍文案',
    ]
  },
  {
    id: 'learn',
    label: '学习',
    icon: BookOpen,
    suggestions: [
      '用简单的语言解释一个复杂概念',
      '为新学科制定一份学习计划',
      '拆解一篇研究论文',
      '给我讲讲某个历史事件',
    ]
  },
  {
    id: 'code',
    label: '代码',
    icon: Code2,
    suggestions: [
      '帮我调试这段代码',
      '写一个函数，实现…',
      '解释这段代码的作用',
      '审查我的代码并给出改进建议',
    ]
  },
  {
    id: 'life',
    label: '生活',
    icon: Home,
    suggestions: [
      '帮我规划一次旅行',
      '制定一周的饮食计划',
      '整理我的日程安排',
      '帮我起草一封邮件',
    ]
  },
  {
    id: 'choice',
    label: '推荐',
    icon: Sparkles,
    suggestions: [
      '给我来点有趣的惊喜',
      '讲一个我可能不知道的冷知识',
      '给我一个创意写作题目',
      '推荐一个思想实验',
    ]
  }
]

const activeCategory = ref<string | null>(null)

function toggleCategory(id: string) {
  activeCategory.value = activeCategory.value === id ? null : id
}

function selectSuggestion(prompt: string) {
  emit('select', prompt)
  activeCategory.value = null
}

function getActiveSuggestions() {
  return categories.find(c => c.id === activeCategory.value)?.suggestions || []
}
</script>

<template>
  <div class="prompt-categories-wrapper">
    <!-- Category Tags -->
    <div class="prompt-categories" role="tablist" aria-label="提示词分类">
      <button
        v-for="cat in categories"
        :key="cat.id"
        class="category-tag"
        :class="{ active: activeCategory === cat.id }"
        role="tab"
        :aria-selected="activeCategory === cat.id"
        @click="toggleCategory(cat.id)"
      >
        <component :is="cat.icon" :size="14" />
        <span>{{ cat.label }}</span>
      </button>
    </div>

    <!-- Suggestion Panel -->
    <div v-if="activeCategory" class="suggestions-panel">
      <div class="suggestions-header">
        <span class="suggestions-title">{{ categories.find(c => c.id === activeCategory)?.label }}</span>
        <button class="suggestions-close" @click="activeCategory = null">
          <X :size="14" />
        </button>
      </div>
      <div class="suggestions-list">
        <button
          v-for="(suggestion, i) in getActiveSuggestions()"
          :key="i"
          class="suggestion-item"
          @click="selectSuggestion(suggestion)"
        >
          {{ suggestion }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.prompt-categories-wrapper {
  width: 100%;
  max-width: var(--input-max-width);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  margin: 0 auto;
  padding: 0 var(--space-md);
}

.prompt-categories {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}

.category-tag {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  font-weight: 400;
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}

.category-tag:hover {
  border-color: var(--border-hover);
  color: var(--text-primary);
  background: var(--bg-elevated);
}

.category-tag:active {
  transform: scale(0.98);
}

.category-tag.active {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-subtle);
}

.category-tag svg {
  opacity: 0.6;
}

.category-tag:hover svg,
.category-tag.active svg {
  opacity: 1;
}

/* Suggestions Panel */
.suggestions-panel {
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-md);
  overflow: hidden;
  animation: suggestionsIn 0.2s ease-out;
}

@keyframes suggestionsIn {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.suggestions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px var(--space-md);
  border-bottom: 1px solid var(--border-subtle);
}

.suggestions-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.suggestions-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all 0.15s ease;
}

.suggestions-close:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}

.suggestions-list {
  display: flex;
  flex-direction: column;
}

.suggestion-item {
  padding: 10px var(--space-md);
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-serif);
  font-size: var(--text-base);
  font-weight: 400;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s ease;
}

.suggestion-item:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
</style>
