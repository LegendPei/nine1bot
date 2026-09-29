/* 带高度过渡的折叠开合。

   grid-template-rows: 0fr → 1fr 要求元素先在场，但长会话里让上千个收起的
   工具输出常驻 DOM 又太贵。所以延迟挂载：先挂上（0fr）、等浏览器画过一帧
   再展开，收起动画结束后再卸载。 */
import { nextTick, onUnmounted, ref } from 'vue'

/** 与 --transition-normal 对齐，收起动画跑完再卸载 */
const CLOSE_DELAY = 200

function afterPaint(): Promise<void> {
  if (typeof requestAnimationFrame !== 'function') return Promise.resolve()
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

export function useCollapse(closeDelay = CLOSE_DELAY) {
  /** 节点是否在 DOM 里 */
  const mounted = ref(false)
  /** 是否处于展开态（驱动 0fr / 1fr） */
  const open = ref(false)
  /** 点击意图先于动画生效；连续点击时不能用尚未更新的 open 判断。 */
  let desiredOpen = false
  let revision = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  async function set(next: boolean) {
    desiredOpen = next
    const current = ++revision
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (next) {
      if (!mounted.value) mounted.value = true
      await nextTick()
      await afterPaint()
      if (current !== revision || !desiredOpen) return
      open.value = true
      return
    }
    open.value = false
    timer = setTimeout(() => {
      timer = undefined
      if (current === revision && !desiredOpen) mounted.value = false
    }, closeDelay)
  }

  onUnmounted(() => {
    revision++
    if (timer) clearTimeout(timer)
  })

  return { mounted, open, set, toggle: () => set(!desiredOpen) }
}
