<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = defineProps<{ text: string; streaming?: boolean }>()
const renderedText = ref('')
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
  try { return DOMPurify.sanitize(marked.parse(renderedText.value, { breaks: true, gfm: true }) as string) }
  catch { return DOMPurify.sanitize(renderedText.value) }
})
</script>

<template><div class="markdown-content" v-html="html" /></template>
