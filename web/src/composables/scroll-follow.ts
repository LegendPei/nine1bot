/* 消息流跟随底部的判定：看方向，不看「离底部多远」。

   按位置判断（离底部小于 N 像素就算贴底）有个手感上的硬伤：触控板一次只走
   几十像素，落在阈值内就仍被算作「还在底部」，下一个 delta 又把人写回底部，
   长回复期间表现出来就是「根本滑不动」。
   改成看方向之后，向上滚一律认成上翻意图；而程序化写入永远是往下写、
   方向恒为正，不可能把自己误判成用户操作。 */

/** 判定「已经贴底」的余量，只用于重新挂上，不用于松手 */
export const NEAR_BOTTOM = 24

/** 惯性回弹会抖出个位数的负值，留一点余量再认成上翻 */
export const UP_SLOP = 2

export const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

export interface Viewport {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export function isAtBottom(viewport: Viewport, threshold = NEAR_BOTTOM): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < threshold
}

/** scroll 事件的归约：向上就松手，自己滑回底部才重新挂上，其余保持原状 */
export function nextFollowing(current: boolean, delta: number, atBottom: boolean): boolean {
  if (delta < -UP_SLOP) return false
  if (delta > 0 && atBottom) return true
  return current
}

/** 焦点在可编辑区域里时，↑ / PageUp 是移动光标，不是翻页 */
export function isTypingTarget(element: Element | null | undefined): boolean {
  if (!element) return false
  const tag = element.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return (element as HTMLElement).isContentEditable === true
}
