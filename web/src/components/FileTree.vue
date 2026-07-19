<script setup lang="ts">
import type { Component } from 'vue'
import { File, FileCode, FileText, FileImage, Folder, FolderOpen } from 'lucide-vue-next'
import type { FileTreeNode } from '../composables/useFiles'

defineProps<{
  files: FileTreeNode[]
  isLoading: boolean
  depth?: number
}>()

const emit = defineEmits<{
  toggle: [node: FileTreeNode]
  select: [node: FileTreeNode]
}>()

function getIcon(node: FileTreeNode): Component {
  if (node.type === 'directory') {
    return node.isExpanded ? FolderOpen : Folder
  }

  const ext = node.name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'vue':
    case 'json':
    case 'css':
    case 'scss':
    case 'html':
      return FileCode
    case 'md':
    case 'txt':
      return FileText
    case 'svg':
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return FileImage
    default:
      return File
  }
}

function handleClick(node: FileTreeNode) {
  if (node.type === 'directory') {
    emit('toggle', node)
  } else {
    emit('select', node)
  }
}
</script>

<template>
  <div class="file-tree">
    <div v-if="isLoading && (!files || files.length === 0)" class="loading">
      加载中...
    </div>

    <div
      v-for="node in files"
      :key="node.path"
      class="file-node"
    >
      <div
        class="file-item"
        :class="{ directory: node.type === 'directory' }"
        @click="handleClick(node)"
      >
        <span class="indent" :style="{ width: `${(depth || 0) * 16}px` }"></span>
        <span v-if="node.type === 'directory'" class="chevron" :class="{ expanded: node.isExpanded }">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 18l6-6-6-6"/>
          </svg>
        </span>
        <span v-else class="chevron-placeholder"></span>
        <component
          :is="getIcon(node)"
          :size="14"
          class="icon"
          :class="{ 'icon-directory': node.type === 'directory' }"
        />
        <span class="name mono">{{ node.name }}</span>
        <span v-if="node.isLoading" class="loading-spinner"></span>
      </div>

      <FileTree
        v-if="node.type === 'directory' && node.isExpanded && node.children"
        :files="node.children"
        :isLoading="node.isLoading || false"
        :depth="(depth || 0) + 1"
        @toggle="emit('toggle', $event)"
        @select="emit('select', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.file-tree {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.loading {
  padding: 12px 16px;
  font-size: var(--text-sm);
  color: var(--text-muted);
}

.file-item {
  display: flex;
  align-items: center;
  padding: 4px 12px;
  cursor: pointer;
  transition: background 0.1s;
  user-select: none;
}

.file-item:hover {
  background: var(--bg-tertiary);
}

.directory {
  font-weight: 500;
}

.indent {
  flex-shrink: 0;
}

.chevron {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--text-muted);
  transition: transform 0.15s;
  flex-shrink: 0;
}

.chevron.expanded {
  transform: rotate(90deg);
}

.chevron-placeholder {
  width: 16px;
  flex-shrink: 0;
}

.icon {
  margin-right: 6px;
  flex-shrink: 0;
  color: var(--text-muted);
}

.icon-directory {
  color: var(--accent);
}

.name {
  font-size: var(--text-13);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.loading-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-blue);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-left: auto;
}
</style>
