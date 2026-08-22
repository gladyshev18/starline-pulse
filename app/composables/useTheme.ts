export type ColorTheme = 'light' | 'dark'

export function useTheme() {
  const theme = useState<ColorTheme>('color-theme', () => 'light')

  function applyTheme(value: ColorTheme) {
    if (!import.meta.client) return
    document.documentElement.dataset.theme = value
    document.documentElement.style.colorScheme = value
    localStorage.setItem('starline-pulse-theme', value)
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      'content',
      value === 'dark' ? '#0b1210' : '#f4f8f6'
    )
  }

  function toggleTheme() {
    theme.value = theme.value === 'light' ? 'dark' : 'light'
    applyTheme(theme.value)
  }

  onMounted(() => {
    const saved = localStorage.getItem('starline-pulse-theme')
    theme.value = saved === 'light' || saved === 'dark'
      ? saved
      : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    applyTheme(theme.value)
  })

  return { theme, toggleTheme }
}
