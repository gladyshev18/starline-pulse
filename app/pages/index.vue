<script setup lang="ts">
const { data, refresh, status } = await useFetch('/api/dashboard')
const syncPending = ref(false)

function number(value: number | null | undefined, digits = 0) {
  if (value == null) return '—'
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value)
}
function date(value: string | Date | null | undefined) {
  return value ? new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Нет данных'
}
async function sync() {
  syncPending.value = true
  try { await $fetch('/api/sync', { method: 'POST' }) } finally { syncPending.value = false }
}
</script>

<template>
  <div>
    <header class="page-heading">
      <div><p class="eyebrow">Обзор</p><h1 class="page-title">{{ data?.vehicle?.alias || 'Автомобиль' }}</h1></div>
    </header>
    <div v-if="status === 'pending'" class="card skeleton">Загрузка…</div>
    <div v-else class="grid">
      <section class="card card--wide state-card">
        <div class="card__top"><p class="eyebrow">Состояние</p></div>
        <div class="state-card__body">
          <div><h2><span class="status-dot" :class="{ 'status-dot--on': data?.snapshot?.ignition }" />{{ data?.snapshot?.ignition ? 'Двигатель работает' : 'Автомобиль в покое' }}</h2><p class="muted">Последняя связь: {{ date(data?.snapshot?.ts) }}</p></div>
          <button class="btn btn--secondary" :disabled="syncPending" @click="sync">{{ syncPending ? 'Обновляем…' : 'Обновить' }}</button>
        </div>
      </section>
      <section class="card metric-card"><div class="card__top"><p class="metric-label">Пробег</p></div><p class="metric">{{ number(data?.snapshot?.mileage, 1) }} <small>км</small></p></section>
      <section class="card metric-card"><div class="card__top"><p class="metric-label">Топливо</p></div><p class="metric">{{ number(data?.snapshot?.fuel, 1) }} <small>л</small></p></section>
      <section class="card metric-card"><div class="card__top"><p class="metric-label">Аккумулятор</p></div><p class="metric">{{ number(data?.snapshot?.battery, 1) }} <small>В</small></p></section>
      <section class="card card--half"><div class="card__top"><p class="metric-label">За месяц</p></div><p class="metric">{{ number(data?.month.distance, 1) }} <small>км</small></p><p class="muted">{{ number(data?.month.fuelUsed, 1) }} л · {{ number(data?.month.consumption, 1) }} л/100 км</p></section>
      <section class="card card--half"><div class="card__top"><p class="metric-label">Лимит API</p></div><p class="metric">{{ number(data?.api.remaining) }} <small>доступно</small></p><p class="muted">{{ number(data?.api.used) }} из 1000 использовано</p></section>
    </div>
  </div>
</template>
