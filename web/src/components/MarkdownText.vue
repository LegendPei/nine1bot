<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { escapeHtml } from '../utils/highlight'
import { copyText } from '../utils/clipboard'

const props = defineProps<{ text: string; streaming?: boolean }>()
const renderedText = ref('')
const renderer = new marked.Renderer()
renderer.code = ({ text, lang }) => `<pre><button type="button" class="copy-code" aria-label="复制代码">复制</button><code${lang ? ` class="language-${escapeHtml(lang.split(/\s/)[0])}"` : ''}>${escapeHtml(text)}</code></pre>`
async function handleClick(event: MouseEvent) {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.copy-code')
  const code = button?.closest('pre')?.querySelector('code')
  if (!button || !code) return
  button.textContent = await copyText(code.textContent || '') ? '已复制' : '复制失败'
}
let timer: ReturnType<typeof setTimeout> | undefined
let lastRender = 0
function flush() {
  if (timer) clearTimeout(timer)
  timer = undefined
  renderedText.value = props.text
  lastRender = Date.now()
}
watch([() => props.text, () => props.streaming], () => {
  if (!props.streaming || !renderedText.value || Date.now() - lastRender >= 32) flush()
  else if (!timer) timer = setTimeout(flush, 32 - (Date.now() - lastRender))
}, { immediate: true })
onUnmounted(() => { if (timer) clearTimeout(timer) })
const html = computed(() => {
  try { return DOMPurify.sanitize(marked.parse(renderedText.value, { breaks: true, gfm: true, renderer }) as string) }
  catch { return DOMPurify.sanitize(renderedText.value) }
})
</script>

<template><div class="markdown-content" @click="handleClick" v-html="html" /></template>
