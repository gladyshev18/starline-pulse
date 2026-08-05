<script setup lang="ts">
defineProps<{
  station: 'rosneft' | 'lukoil' | 'other'
  name?: string | null
}>()
</script>

<template>
  <span class="station-badge" :class="`station-badge--${station}`">
    <svg v-if="station === 'rosneft'" viewBox="0 0 32 32" aria-hidden="true">
      <path fill="#f4c900" d="M5 4h22v7l-4 3v12l-7 4-7-4V14l-4-3z" />
      <path fill="#171717" d="m9 7 14 0v3H9zm3 6h11v3H12zm0 6h8v3h-8zm0 6h5v3h-5z" />
    </svg>
    <svg v-else-if="station === 'lukoil'" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#d71920" />
      <path fill="#fff" d="M7 7h5v13h5v5H7zm12 0h6v5h-3v3h3v5h-6z" />
    </svg>
    <svg v-else viewBox="0 0 32 32" aria-hidden="true">
      <path d="M8 27V6h12v21M8 11h12M11 16h6M20 10h3l3 4v10a2 2 0 0 1-4 0v-7" />
    </svg>
    <span>{{ station === 'rosneft' ? 'Роснефть' : station === 'lukoil' ? 'Лукойл' : (name || 'Другая АЗС') }}</span>
  </span>
</template>

<style scoped>
.station-badge { display: inline-flex; min-height: 34px; align-items: center; gap: 9px; padding: 4px 11px 4px 5px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); font-size: .72rem; font-weight: 720; }
.station-badge svg { width: 25px; height: 25px; flex: 0 0 25px; }
.station-badge--other svg { fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.station-badge--rosneft { color: var(--ink); }
.station-badge--lukoil { color: #b8141a; }
.station-badge--other { color: var(--accent-ink); }
</style>
