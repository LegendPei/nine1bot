import { ref, watchEffect } from 'vue'

type Theme = 'light' | 'dark'

const storedTheme = localStorage.getItem('nine1bot-theme') as Theme | null
const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches

const theme = ref<Theme>(storedTheme || (systemPrefersDark ? 'dark' : 'light'))

// 模块级单例：模块加载（App 启动）即应用主题并持久化，
// 不依赖任何组件挂载，也不随组件卸载而停止
watchEffect(() => {
  document.documentElement.setAttribute('data-theme', theme.value)
  localStorage.setItem('nine1bot-theme', theme.value)
})

export function useTheme() {
  const toggleTheme = () => {
    theme.value = theme.value === 'dark' ? 'light' : 'dark'
  }

  const setTheme = (newTheme: Theme) => {
    theme.value = newTheme
  }

  return {
    theme,
    toggleTheme,
    setTheme
  }
}
