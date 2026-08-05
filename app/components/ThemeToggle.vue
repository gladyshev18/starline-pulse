<script setup lang="ts">
const { theme, toggleTheme } = useTheme()
</script>

<template>
  <button
    class="icon-button theme-toggle"
    type="button"
    :aria-label="theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'"
    :title="theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'"
    @click="toggleTheme"
  >
    <svg v-if="theme === 'dark'" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2.5v2M12 19.5v2M21.5 12h-2M4.5 12h-2M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4M18.7 18.7l-1.4-1.4M6.7 6.7 5.3 5.3" />
    </svg>
    <svg v-else viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 15.2A8.5 8.5 0 0 1 8.8 4a7.8 7.8 0 1 0 11.2 11.2Z" />
    </svg>
  </button>
</template>
