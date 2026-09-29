/* 折起时那一行摘要的信息量。

   回归点：原来折起后只写「N 个步骤」，跑了什么、失败没失败全看不见。
   这组断言钉住三件事：调用总数、按次数排序的前两种工具、失败次数必须冒头。 */
import { describe, expect, it } from 'bun:test'
import { summarizeTools } from '../src/utils/step-summary'

const called = (...labels: string[]) => labels.map(label => ({ label }))

describe('summarizeTools', () => {
  it('falls back to the step count when no tool ran', () => {
    expect(summarizeTools([], 3)).toBe('3 个步骤')
    expect(summarizeTools([])).toBe('无操作')
  })

  it('omits the multiplier for a single call', () => {
    expect(summarizeTools(called('读取'), 1)).toBe('1 次调用 · 读取')
  })

  it('ranks by frequency and folds the long tail into a kind count', () => {
    expect(summarizeTools(called('读取', '读取', '读取', '编辑', '编辑', '搜索'), 4))
      .toBe('6 次调用 · 读取 ×3 · 编辑 ×2 · 等 3 种')
  })

  it('breaks ties by name so the line does not reshuffle between renders', () => {
    expect(summarizeTools(called('B', 'A'))).toBe('2 次调用 · A · B')
  })

  it('surfaces failures at the end', () => {
    const tools = [
      { label: '读取', status: 'completed' },
      { label: '读取', status: 'error' },
      { label: '编辑', status: 'error' },
    ]
    expect(summarizeTools(tools)).toBe('3 次调用 · 读取 ×2 · 编辑 · 2 次失败')
  })
})
