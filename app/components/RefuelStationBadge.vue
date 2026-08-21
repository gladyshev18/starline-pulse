<script setup lang="ts">
defineProps<{
  station: 'rosneft' | 'lukoil' | 'other'
  name?: string | null
}>()
</script>

<template>
  <span class="station-badge" :class="`station-badge--${station}`">
    <!-- Марки нарисованы здесь, а не взяты у сетей: узнаваемы по фирменному
         цвету и форме, но официальными знаками не являются. -->
    <svg v-if="station === 'rosneft'" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="13" fill="#ffcc00" />
      <path fill="#141414" d="M4.6 20.6C9 10.5 19.5 6.5 27 9.5 19 13.5 12 18.5 8.5 25z" />
    </svg>
    <svg v-else-if="station === 'lukoil'" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="13" fill="#e01f26" />
      <path fill="#fff" d="M16 7.4c-3.4 4-5.5 6.9-5.5 9.6a5.5 5.5 0 0 0 11 0c0-2.7-2.1-5.6-5.5-9.6z" />
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
