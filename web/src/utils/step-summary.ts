/* 折起时的过程摘要。只显示「最后一个工具的名字」的话，10 次调用和 1 次调用
   长得一模一样，也看不出中途失败过——而失败恰恰是折起状态下最需要冒头的信息。 */

export interface ToolTally {
  /** 工具的展示名，用于归类计数 */
  label: string
  status?: string
}

/**
 * 摘要格式：`12 次调用 · 读取 ×6 · 编辑 ×3 · 等 4 种 · 1 次失败`
 * 只列最主要的两类，剩下的用「等 N 种」收口，保证摘要始终是一行。
 */
export function summarizeTools(tools: ToolTally[], stepCount = 0): string {
  if (tools.length === 0) return stepCount > 0 ? `${stepCount} 个步骤` : '无操作'

  const counts = new Map<string, number>()
  for (const tool of tools) counts.set(tool.label, (counts.get(tool.label) ?? 0) + 1)
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  const parts = [`${tools.length} 次调用`]
  for (const [label, count] of ranked.slice(0, 2)) parts.push(count > 1 ? `${label} ×${count}` : label)
  if (ranked.length > 2) parts.push(`等 ${ranked.length} 种`)

  const failed = tools.filter((tool) => tool.status === 'error').length
  if (failed > 0) parts.push(`${failed} 次失败`)

  return parts.join(' · ')
}
