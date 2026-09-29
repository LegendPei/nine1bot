/* 滚动跟随的判定。

   回归点：用户上翻 20px（比旧实现 100px 的贴底死区小得多）之后，
   流式增长不许再把他拽回底部——这正是「长回复期间根本滑不动」的成因。
   把 nextFollowing 换回「离底部 < 100px 就算贴底」的老写法，这组断言会当场翻红。 */
import { describe, expect, it } from 'bun:test'
import { isAtBottom, isTypingTarget, nextFollowing, NEAR_BOTTOM } from '../src/composables/scroll-follow'

const VIEW = 800
const HEIGHT = 4000
const BOTTOM = HEIGHT - VIEW

const viewport = (scrollTop: number) => ({ scrollTop, scrollHeight: HEIGHT, clientHeight: VIEW })

describe('nextFollowing', () => {
  it('releases on a tiny scroll up that the old distance threshold would have swallowed', () => {
    const top = BOTTOM - 20
    // 20px 落在旧的 100px 死区内，按位置判断会认成「还在底部」
    expect(HEIGHT - top - VIEW).toBeLessThan(100)
    expect(nextFollowing(true, -20, isAtBottom(viewport(top)))).toBe(false)
  })

  it('releases even while still inside the near-bottom window', () => {
    const top = BOTTOM - (NEAR_BOTTOM - 1)
    expect(isAtBottom(viewport(top))).toBe(true)
    // 方向优先于位置：仍然贴底，但方向是向上，就该松手
    expect(nextFollowing(true, -10, true)).toBe(false)
  })

  it('ignores the single-digit negative jitter of inertial bounce', () => {
    expect(nextFollowing(true, -1, true)).toBe(true)
    expect(nextFollowing(true, -2, true)).toBe(true)
    expect(nextFollowing(true, -3, true)).toBe(false)
  })

  it('stays released while scrolling down but not yet at the bottom', () => {
    expect(nextFollowing(false, 120, isAtBottom(viewport(BOTTOM - 400)))).toBe(false)
  })

  it('re-attaches only when the user reaches the bottom again', () => {
    expect(nextFollowing(false, 20, isAtBottom(viewport(BOTTOM)))).toBe(true)
  })

  it('cannot mistake a programmatic write for user intent', () => {
    // 程序化写入永远是往下写到底，方向恒为正
    expect(nextFollowing(true, 480, true)).toBe(true)
    expect(nextFollowing(false, 480, true)).toBe(true)
  })

  it('holds the current state when nothing moved', () => {
    expect(nextFollowing(true, 0, true)).toBe(true)
    expect(nextFollowing(false, 0, true)).toBe(false)
  })
})

describe('isAtBottom', () => {
  it('measures the gap below the viewport', () => {
    expect(isAtBottom(viewport(BOTTOM))).toBe(true)
    expect(isAtBottom(viewport(BOTTOM - NEAR_BOTTOM))).toBe(false)
    expect(isAtBottom(viewport(0))).toBe(false)
  })
})

describe('isTypingTarget', () => {
  it('treats form fields and contenteditable as typing targets', () => {
    expect(isTypingTarget({ tagName: 'INPUT' } as Element)).toBe(true)
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as Element)).toBe(true)
    expect(isTypingTarget({ tagName: 'SELECT' } as Element)).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as Element)).toBe(true)
  })

  it('lets ↑ / PageUp release the scroll everywhere else', () => {
    expect(isTypingTarget({ tagName: 'DIV' } as Element)).toBe(false)
    expect(isTypingTarget({ tagName: 'BODY' } as Element)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
