/* 把 Markdown 切成顶层块来渲染，流式时只把变化的那一块落地到 DOM。

   整篇 v-html 每 32ms 重建一次的代价不只是性能：选中会丢、代码块的横向滚动位置
   会归零、按块做动效也无从下手，而且成本随回复变长线性增加。
   这里先整篇 lexer（引用式链接定义是文档级的，必须整篇解析才能解析对），
   再逐 token parser 出一段 HTML，交给调用方按下标 diff。 */
import { marked } from 'marked'
import type { MarkedOptions, Token } from 'marked'
import { escapeHtml } from './highlight'

/** 一篇 Markdown 渲染出的顶层块，下标即出现顺序 */
export type MarkdownBlocks = string[]

export type BlockOp =
  | { type: 'insert'; index: number; html: string }
  | { type: 'replace'; index: number; html: string }
  | { type: 'remove'; index: number }

export interface BlockRendererOptions {
  /** lexer 与 parser 必须共用同一份，否则 gfm / breaks 的行为会不一致 */
  markedOptions?: MarkedOptions
  /** 浏览器里传 DOMPurify.sanitize；默认原样返回，方便在没有 DOM 的环境下测纯逻辑 */
  sanitize?: (html: string) => string
}

/** lexer 会把引用式链接定义挂在返回值的 links 上 */
type LexResult = Token[] & { links?: Record<string, unknown> }

/**
 * 建一个带缓存的块渲染器。缓存以 token 的原文为键——流式追加时前面的 token 原文不变，
 * 于是只有尾块需要重新 parse + 消毒。
 */
export function createMarkdownBlockRenderer(options: BlockRendererOptions = {}) {
  const markedOptions: MarkedOptions = { breaks: true, gfm: true, ...options.markedOptions }
  const sanitize = options.sanitize ?? ((html: string) => html)
  let cache = new Map<string, string>()

  return function renderBlocks(source: string): MarkdownBlocks {
    if (!source) {
      cache = new Map()
      return []
    }

    let tokens: LexResult
    try {
      tokens = marked.lexer(source, markedOptions) as LexResult
    } catch {
      return [`<p>${escapeHtml(source)}</p>`]
    }

    /* 引用式定义是文档级的：同一段原文在定义到达前后应当渲染成不同结果，
       所以把定义表并进缓存键，没有定义时它是空串、不产生任何影响。 */
    const scope = Object.keys(tokens.links ?? {}).sort().join(',')
    const next = new Map<string, string>()
    const blocks: MarkdownBlocks = []

    for (const token of tokens) {
      const key = `${scope}\u0000${token.type}\u0000${token.raw}`
      let html = next.get(key) ?? cache.get(key)
      if (html === undefined) {
        try {
          html = sanitize(marked.parser([token], markedOptions)).trim()
        } catch {
          html = `<p>${escapeHtml(token.raw)}</p>`
        }
      }
      next.set(key, html)
      if (html) blocks.push(html)
    }

    cache = next
    return blocks
  }
}

/**
 * 按下标比较两次渲染结果。删除排在最前且从尾部倒着删，避免下标漂移。
 * 流式追加的典型结果是「只 replace 最后一块」或「replace 最后一块 + insert 一块」。
 */
export function diffBlocks(prev: MarkdownBlocks, next: MarkdownBlocks): BlockOp[] {
  const removals: BlockOp[] = []
  for (let i = next.length; i < prev.length; i++) removals.push({ type: 'remove', index: i })
  removals.reverse()

  const ops: BlockOp[] = removals
  for (let i = 0; i < next.length; i++) {
    if (i >= prev.length) ops.push({ type: 'insert', index: i, html: next[i] })
    else if (prev[i] !== next[i]) ops.push({ type: 'replace', index: i, html: next[i] })
  }
  return ops
}

/** 把 diff 落到真实 DOM 上。块与子元素一一对应，所以下标可以直接当定位用。 */
export function applyBlockOps(host: Element, ops: BlockOp[], blocks: MarkdownBlocks): void {
  for (const op of ops) {
    if (op.type === 'remove') {
      host.children[op.index]?.remove()
      continue
    }
    const current = op.type === 'replace' ? host.children[op.index] : undefined
    if (current) current.outerHTML = op.html
    else host.insertAdjacentHTML('beforeend', op.html)
  }

  /* 自愈：一个顶层 token 通常只吐一个元素，但内嵌 HTML 块可能吐好几个。
     下标一旦错位，后续每次 diff 都会改错位置，所以发现不一致就整篇重建。 */
  if (host.children.length !== blocks.length) host.innerHTML = blocks.join('')
}
