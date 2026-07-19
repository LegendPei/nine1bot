import { ref } from 'vue'
import { api, type FileItem, type FileContent, type FileSearchResult } from '../api/client'

// 文件内容超过该字符数时截断展示（约 500KB 文本）
export const MAX_FILE_CONTENT_CHARS = 500 * 1024

export interface FileTreeNode extends FileItem {
  children?: FileTreeNode[]
  isExpanded?: boolean
  isLoading?: boolean
}

export function useFiles() {
  const files = ref<FileTreeNode[]>([])
  const isLoading = ref(false)
  const currentPath = ref('')
  const currentDirectory = ref<string | undefined>(undefined)

  // 文件内容查看
  const fileContent = ref<FileContent | null>(null)
  const isLoadingContent = ref(false)
  const contentError = ref<string | null>(null)
  // 大文件保护：内容被截断时置 true，FileViewer 据此显示提示条
  const isContentTruncated = ref(false)

  // 文件搜索
  const searchResults = ref<FileSearchResult[]>([])
  const isSearching = ref(false)
  const searchError = ref<string | null>(null)

  // 设置工作目录
  function setDirectory(directory: string | undefined) {
    currentDirectory.value = directory
  }

  // 递增请求序号，响应返回时只有最新请求才能写入状态（防乱序竞态）
  let loadFilesRequest = 0
  let loadContentRequest = 0
  let contentRequestPath = ''
  let searchRequest = 0

  async function loadFiles(path: string = '') {
    const requestId = ++loadFilesRequest
    try {
      isLoading.value = true
      currentPath.value = path
      const items = await api.getFiles(path, currentDirectory.value)
      if (requestId !== loadFilesRequest) return

      // 排序：目录在前，文件在后，按名称排序
      files.value = items
        .map(item => ({ ...item, children: undefined, isExpanded: false, isLoading: false }))
        .sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name)
          return a.type === 'directory' ? -1 : 1
        })
    } catch (error) {
      if (requestId !== loadFilesRequest) return
      console.error('Failed to load files:', error)
      files.value = []
    } finally {
      if (requestId === loadFilesRequest) {
        isLoading.value = false
      }
    }
  }

  async function toggleDirectory(node: FileTreeNode) {
    if (node.type !== 'directory') return

    if (node.isExpanded) {
      node.isExpanded = false
      return
    }

    node.isLoading = true
    try {
      const children = await api.getFiles(node.path, currentDirectory.value)
      node.children = children
        .map(item => ({ ...item, children: undefined, isExpanded: false, isLoading: false }))
        .sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name)
          return a.type === 'directory' ? -1 : 1
        })
      node.isExpanded = true
    } catch (error) {
      console.error('Failed to load directory:', error)
    } finally {
      node.isLoading = false
    }
  }

  // 加载文件内容
  async function loadFileContent(path: string) {
    const requestId = ++loadContentRequest
    contentRequestPath = path
    isLoadingContent.value = true
    contentError.value = null
    isContentTruncated.value = false
    try {
      const content = await api.getFileContent(path, currentDirectory.value)
      if (requestId !== loadContentRequest || contentRequestPath !== path) return
      // 大文件保护：超长文本截断，避免一次性渲染拖垮页面
      if (content.content && content.content.length > MAX_FILE_CONTENT_CHARS) {
        fileContent.value = { ...content, content: content.content.slice(0, MAX_FILE_CONTENT_CHARS) }
        isContentTruncated.value = true
      } else {
        fileContent.value = content
      }
    } catch (error: any) {
      if (requestId !== loadContentRequest || contentRequestPath !== path) return
      console.error('Failed to load file content:', error)
      contentError.value = error.message || '无法加载文件内容'
      fileContent.value = null
    } finally {
      if (requestId === loadContentRequest) {
        isLoadingContent.value = false
      }
    }
  }

  // 清除文件内容
  function clearFileContent() {
    fileContent.value = null
    contentError.value = null
    isContentTruncated.value = false
  }

  // 搜索文件
  async function searchFiles(pattern: string) {
    const requestId = ++searchRequest
    if (!pattern.trim()) {
      searchResults.value = []
      return
    }

    isSearching.value = true
    searchError.value = null
    try {
      const results = await api.searchFiles(pattern)
      if (requestId !== searchRequest) return
      searchResults.value = results
    } catch (error: any) {
      if (requestId !== searchRequest) return
      console.error('Failed to search files:', error)
      searchError.value = error.message || '搜索失败'
      searchResults.value = []
    } finally {
      if (requestId === searchRequest) {
        isSearching.value = false
      }
    }
  }

  // 清除搜索结果
  function clearSearch() {
    searchResults.value = []
    searchError.value = null
  }

  return {
    files,
    isLoading,
    currentPath,
    currentDirectory,
    setDirectory,
    loadFiles,
    toggleDirectory,
    // 文件内容
    fileContent,
    isLoadingContent,
    contentError,
    isContentTruncated,
    loadFileContent,
    clearFileContent,
    // 文件搜索
    searchResults,
    isSearching,
    searchError,
    searchFiles,
    clearSearch
  }
}
