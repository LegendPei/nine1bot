// 工具显示名映射（ToolCall / AgentSteps 共用，避免两处重复维护）
export const TOOL_DISPLAY_NAMES: Record<string, string> = {
  read: '读取',
  write: '写入',
  edit: '编辑',
  bash: '命令',
  grep: '搜索',
  glob: '匹配',
  list: '列目录',
  webfetch: '访问网页',
  task: '子任务',
  todowrite: '待办',
  todoread: '待办',
}

export function getToolDisplayName(toolName: string, fallback = '工具'): string {
  return TOOL_DISPLAY_NAMES[toolName.toLowerCase()] || toolName || fallback
}
