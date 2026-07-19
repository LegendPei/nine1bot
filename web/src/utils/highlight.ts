// HTML 转义，防止标题等用户/AI 数据在 v-html 中注入
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// 高亮匹配文本：先对整体做 HTML 转义，再对转义后的搜索词做正则转义并包裹 <mark>
export function highlightMatch(text: string, search: string): string {
  const escapedText = escapeHtml(text)
  const term = search.trim()
  if (!term) return escapedText
  const escapedTerm = escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!escapedTerm) return escapedText
  const regex = new RegExp(`(${escapedTerm})`, 'gi')
  return escapedText.replace(regex, '<mark>$1</mark>')
}
