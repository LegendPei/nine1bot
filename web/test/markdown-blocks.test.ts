/* 流式 Markdown 的块级 diff。

   回归点：原实现每 32ms 用 v-html 重写整棵子树，长回复里的代码块、图片、
   选中的文字每帧都被换掉。这组断言钉住「尾块以外一个下标都不许动」，
   一旦谁把 renderBlocks 改回整篇渲染，第二组就会翻红。 */
import { describe, expect, it } from 'bun:test'
import { applyBlockOps, createMarkdownBlockRenderer, diffBlocks } from '../src/utils/markdown-blocks'

/** 标题 + 一段正文，后面接流式增长的尾巴 */
const HEAD = '# 标题\n\n第一段。\n\n'

/** applyBlockOps 只用到 children / outerHTML / insertAdjacentHTML / innerHTML 这几处 */
function fakeHost(initial: string[] = []) {
  const items = [...initial]
  let healed: string | null = null
  const element = {
    get children() {
      return items.map((_, index) => ({
        get outerHTML() { return items[index] },
        set outerHTML(html: string) { items[index] = html },
        remove() { items.splice(index, 1) },
      }))
    },
    set innerHTML(html: string) { healed = html },
    insertAdjacentHTML(_position: string, html: string) { items.push(html) },
  }
  return { element: element as unknown as Element, items, healed: () => healed }
}

describe('createMarkdownBlockRenderer', () => {
  it('emits one html string per top-level block', () => {
    const blocks = createMarkdownBlockRenderer()('# 标题\n\n第一段。\n\n- a\n- b')
    expect(blocks.length).toBe(3)
    expect(blocks[0]).toContain('<h1')
    expect(blocks[1]).toContain('<p>')
    expect(blocks[2]).toContain('<ul>')
  })

  it('keeps every earlier block byte-identical while the tail grows', () => {
    const renderBlocks = createMarkdownBlockRenderer()
    const before = renderBlocks(HEAD + '正在输出')
    const after = renderBlocks(HEAD + '正在输出的一段话。')
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2))
    expect(after[2]).not.toBe(before[2])
  })

  it('touches only the tail index when a streaming delta lands', () => {
    const renderBlocks = createMarkdownBlockRenderer()
    const before = renderBlocks(HEAD + '正在输出')
    const after = renderBlocks(HEAD + '正在输出的一段话。')
    expect(diffBlocks(before, after)).toEqual([{ type: 'replace', index: 2, html: after[2] }])
  })

  it('appends a single insert when the model starts a new paragraph', () => {
    const renderBlocks = createMarkdownBlockRenderer()
    const before = renderBlocks(HEAD + '一段话。')
    const after = renderBlocks(HEAD + '一段话。\n\n新的一段')
    expect(diffBlocks(before, after)).toEqual([{ type: 'insert', index: 3, html: after[3] }])
  })

  it('re-renders a block when its reference definition arrives later', () => {
    // 引用式定义是文档级的：同一段原文在定义到达前后该渲染成不同结果
    const renderBlocks = createMarkdownBlockRenderer()
    const plain = renderBlocks('见 [文档][d]。')
    const linked = renderBlocks('见 [文档][d]。\n\n[d]: https://example.com')
    expect(plain[0]).not.toContain('href')
    expect(linked[0]).toContain('href="https://example.com"')
  })

  it('updates an existing reference when its destination or title changes', () => {
    const renderBlocks = createMarkdownBlockRenderer()
    const before = renderBlocks('见 [文档][d]。\n\n[d]: https://a.example "旧标题"')
    const after = renderBlocks('见 [文档][d]。\n\n[d]: https://b.example "新标题"')
    expect(before[0]).toContain('href="https://a.example"')
    expect(after[0]).toContain('href="https://b.example"')
    expect(after[0]).toContain('title="新标题"')
    expect(after[0]).not.toContain('a.example')
  })

  it('lets sanitize rewrite every emitted block', () => {
    const seen: string[] = []
    const renderBlocks = createMarkdownBlockRenderer({
      sanitize: (html) => { seen.push(html); return html.replace('<p>', '<p data-clean>') },
    })
    const blocks = renderBlocks('一段。\n\n两段。')
    expect(blocks.length).toBe(2)
    // 段落之间的 space token 也会走一遍，但渲染成空串后不进结果
    expect(seen.filter(html => html.includes('<p>')).length).toBe(2)
    expect(blocks.every(block => block.startsWith('<p data-clean>'))).toBe(true)
  })

  it('renders only the changed block on the next pass', () => {
    let calls = 0
    const renderBlocks = createMarkdownBlockRenderer({
      sanitize: (html) => { calls++; return html },
    })
    renderBlocks(HEAD + '尾巴')
    const rendered = calls
    renderBlocks(HEAD + '尾巴长了一点')
    // 前两块命中缓存，只有尾块重新过一遍 marked
    expect(calls - rendered).toBe(1)
  })

  it('returns nothing for empty text', () => {
    expect(createMarkdownBlockRenderer()('')).toEqual([])
  })
})

describe('diffBlocks', () => {
  it('emits removals from the tail first so indexes never drift', () => {
    expect(diffBlocks(['a', 'b', 'c', 'd'], ['a', 'b'])).toEqual([
      { type: 'remove', index: 3 },
      { type: 'remove', index: 2 },
    ])
  })

  it('replaces in place and appends the rest', () => {
    expect(diffBlocks(['a', 'b'], ['a', 'B', 'c'])).toEqual([
      { type: 'replace', index: 1, html: 'B' },
      { type: 'insert', index: 2, html: 'c' },
    ])
  })

  it('says nothing when nothing changed', () => {
    expect(diffBlocks(['a', 'b'], ['a', 'b'])).toEqual([])
  })
})

describe('applyBlockOps', () => {
  it('rewrites only the tail element while streaming', () => {
    const prev = ['<h1>t</h1>', '<p>a</p>', '<p>ta</p>']
    const next = ['<h1>t</h1>', '<p>a</p>', '<p>tail</p>']
    const host = fakeHost(prev)
    applyBlockOps(host.element, diffBlocks(prev, next), next)
    expect(host.items).toEqual(next)
    expect(host.healed()).toBe(null)
  })

  it('appends new blocks at the end', () => {
    const host = fakeHost()
    const next = ['<p>a</p>', '<p>b</p>']
    applyBlockOps(host.element, diffBlocks([], next), next)
    expect(host.items).toEqual(next)
    expect(host.healed()).toBe(null)
  })

  it('drops trailing elements without disturbing the survivors', () => {
    const prev = ['a', 'b', 'c', 'd']
    const next = ['a', 'b']
    const host = fakeHost(prev)
    applyBlockOps(host.element, diffBlocks(prev, next), next)
    expect(host.items).toEqual(next)
    expect(host.healed()).toBe(null)
  })

  it('rebuilds the host when one block rendered several sibling elements', () => {
    // 内嵌 HTML 块可能一口气吐出好几个兄弟元素，下标就此错位，只能整篇重建
    const host = fakeHost(['<div>a</div>', '<div>b</div>'])
    const next = ['<div>a</div><div>b</div>']
    applyBlockOps(host.element, [{ type: 'replace', index: 0, html: next[0] }], next)
    expect(host.healed()).toBe(next[0])
  })
})
