import { describe, expect, it } from 'bun:test'
import { getFileName } from '../src/utils/path'

describe('getFileName', () => {
  it('handles Windows backslash paths', () => {
    expect(getFileName('C:\\a\\b.ts')).toBe('b.ts')
    expect(getFileName('C:\\Users\\foo\\project\\index.vue')).toBe('index.vue')
  })

  it('handles Unix paths', () => {
    expect(getFileName('/home/user/a.ts')).toBe('a.ts')
  })

  it('handles mixed separators', () => {
    expect(getFileName('C:\\a/b\\c.ts')).toBe('c.ts')
  })

  it('returns the input for bare names', () => {
    expect(getFileName('a.ts')).toBe('a.ts')
  })
})
