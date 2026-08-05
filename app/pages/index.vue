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
function batteryUnit(type: string | null | undefined) {
  return type === 'percent' ? '%' : type === 'volt' ? 'В' : ''
}
function isStale(value: string | Date | null | undefined) {
  if (!value) return false
  const reference = data.value?.snapshot?.activityTs || data.value?.snapshot?.ts
  return Boolean(reference && new Date(reference).getTime() - new Date(value).getTime() > 30 * 60_000)
}
function updated(value: string | Date | null | undefined) {
  if (!value) return 'Время обновления неизвестно'
  return `${isStale(value) ? 'Данные устарели' : 'Данные на'} ${date(value)}`
}
const vehicleState = computed(() => {
  const snapshot = data.value?.snapshot
  if (!snapshot || snapshot.online == null) return 'Состояние неизвестно'
  if (!snapshot.online) return 'Устройство не в сети'
  if (snapshot.ignition == null) return 'Состояние двигателя неизвестно'
  return snapshot.ignition ? 'Двигатель работает' : 'Автомобиль в покое'
})
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
          <div><h2><span class="status-dot" :class="{ 'status-dot--on': data?.snapshot?.online && data?.snapshot?.ignition, 'status-dot--offline': data?.snapshot?.online === false }" />{{ vehicleState }}</h2><p class="muted">Последняя связь: {{ date(data?.snapshot?.activityTs) }}</p></div>
          <button class="btn btn--secondary" :disabled="syncPending" @click="sync">{{ syncPending ? 'Обновляем…' : 'Обновить' }}</button>
        </div>
      </section>
      <section class="card metric-card"><div class="card__top"><p class="metric-label">Пробег</p></div><p class="metric">{{ number(data?.snapshot?.mileage, 1) }} <small>км</small></p><p class="metric-meta" :class="{ 'metric-meta--stale': isStale(data?.snapshot?.mileageTs) }">{{ updated(data?.snapshot?.mileageTs) }}</p></section>
      <section class="card metric-card"><div class="card__top"><p class="metric-label">Топливо</p></div><p class="metric">{{ number(data?.snapshot?.fuel, 1) }} <small>л</small></p><p class="metric-meta" :class="{ 'metric-meta--stale': isStale(data?.snapshot?.fuelTs) }">{{ data?.snapshot?.fuelPercent == null ? '' : `${number(data.snapshot.fuelPercent)}% · ` }}{{ data?.snapshot?.fuelSource === 'converted' ? 'пересчёт API · ' : '' }}{{ updated(data?.snapshot?.fuelTs) }}</p></section>
      <section class="card metric-card"><div class="card__top"><p class="metric-label">Аккумулятор</p></div><p class="metric">{{ number(data?.snapshot?.battery, 1) }} <small>{{ batteryUnit(data?.snapshot?.batteryType) }}</small></p><p class="metric-meta" :class="{ 'metric-meta--stale': isStale(data?.snapshot?.commonTs) }">{{ updated(data?.snapshot?.commonTs) }}</p></section>
      <section class="card card--half"><div class="card__top"><p class="metric-label">За месяц</p></div><p class="metric">{{ number(data?.month.distance, 1) }} <small>км</small></p><p class="muted">{{ number(data?.month.fuelUsed, 1) }} л · {{ number(data?.month.consumption, 1) }} л/100 км</p></section>
      <section class="card card--half"><div class="card__top"><p class="metric-label">Лимит API</p></div><p class="metric">{{ number(data?.api.remaining) }} <small>доступно</small></p><p class="muted">{{ number(data?.api.used) }} из 1000 использовано</p></section>
    </div>
  </div>
</template>
