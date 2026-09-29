<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { escapeHtml } from '../utils/highlight'
import { copyText } from '../utils/clipboard'
import {
  applyBlockOps,
  createMarkdownBlockRenderer,
  diffBlocks,
  type MarkdownBlocks,
} from '../utils/markdown-blocks'

const props = defineProps<{ text: string; streaming?: boolean }>()

const host = ref<HTMLDivElement>()
const renderer = new marked.Renderer()
renderer.code = ({ text, lang }) => `<pre><button type="button" class="copy-code" aria-label="复制代码">复制</button><code${lang ? ` class="language-${escapeHtml(lang.split(/\s/)[0])}"` : ''}>${escapeHtml(text)}</code></pre>`

async function handleClick(event: MouseEvent) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.copy-code')
  const code = button?.closest('pre')?.querySelector('code')
  if (!button || !code) return
  button.textContent = await copyText(code.textContent || '') ? '已复制' : '复制失败'
}

const renderBlocks = createMarkdownBlockRenderer({
  markedOptions: { breaks: true, gfm: true, renderer },
  sanitize: (html) => DOMPurify.sanitize(html),
})

/* 上一次落到 DOM 上的块，用来算 diff。流式追加时通常只有尾块变化，
   前面的块一个都不碰——选中不会丢，代码块的横向滚动位置也不会归零。 */
let blocks: MarkdownBlocks = []

function paint() {
  const element = host.value
  if (!element) return
  const next = renderBlocks(props.text)
  applyBlockOps(element, diffBlocks(blocks, next), next)
  blocks = next
}

/* 帧内合并：一帧里来几个 delta 只重排一次版 */
let timer: ReturnType<typeof setTimeout> | undefined
let lastRender = 0
function flush() {
  if (timer) clearTimeout(timer)
  timer = undefined
  lastRender = Date.now()
  paint()
}

watch([() => props.text, () => props.streaming], () => {
  if (!props.streaming || blocks.length === 0 || Date.now() - lastRender >= 32) flush()
  else if (!timer) timer = setTimeout(flush, 32 - (Date.now() - lastRender))
})

onMounted(flush)
onUnmounted(() => { if (timer) clearTimeout(timer) })
</script>

<template>
  <div
    ref="host"
    class="markdown-content"
    :class="{ 'is-streaming': streaming }"
    @click="handleClick"
  />
</template>
